import { t } from '../i18n';
import { Children, createContext, isValidElement, useContext, type ReactNode } from 'react';
import { Globe } from 'lucide-react';
import Markdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { localPreviewPath, localPreviewUrl, relativeToFile } from '../lib/local-files';
import { useFilePreview } from './FilePreviewProvider';
import { localImagePath, localImageUrl } from '../lib/local-images';
import { LocalImage, RemoteImage, useImagePreview } from './ImagePreview';
import { ControlHint } from './ControlHint';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { MermaidBlock } from './MermaidBlock';
import { isClosedCodeFence } from '../lib/markdown-fence';
import { parseVisualizationReference } from '../../shared/visualization';
import { VisualizationBlock } from './VisualizationBlock';

// Preserve the default protocol allowlist for ordinary links and remote images.
const transformUrl: UrlTransform = (url, key) =>
  localImagePath(url, key === 'src') || (key === 'href' && localPreviewPath(url))
    ? url
    : defaultUrlTransform(url);

const BaseFileContext = createContext<string | undefined>(undefined);
const ImageLinkContext = createContext(false);
const SourceContext = createContext({ text: '', streaming: false });

function browserCompletionTitle(source: string) {
  const quotedTitle =
    /^::browser-complete\{[ \t]*title[ \t]*=[ \t]*("(?:[^"\\\r\n]|\\.)*")[ \t]*\}$/.exec(
      source,
    )?.[1];
  if (!quotedTitle) return undefined;
  try {
    return (JSON.parse(quotedTitle) as string).trim();
  } catch {
    return undefined;
  }
}

// Stable renderer identities preserve table focus and image state while streaming.
const markdownComponents: Components = {
  pre: function CodeBlock({ children, node }) {
    const { text, streaming } = useContext(SourceContext);
    const code = Children.toArray(children)[0];
    if (
      isValidElement<{ className?: string; children?: ReactNode }>(code) &&
      code.type === 'code' &&
      code.props.className?.toLowerCase() === 'language-mermaid'
    ) {
      const fenced = text.slice(node?.position?.start.offset, node?.position?.end.offset);
      return (
        <MermaidBlock
          source={String(code.props.children ?? '')}
          pending={streaming && !isClosedCodeFence(fenced)}
        />
      );
    }
    return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
  },
  a: function FileLink({ children, href, title }) {
    const { threadId, open } = useImagePreview();
    const baseFile = useContext(BaseFileContext);
    const preview = useFilePreview();
    const filePath = href ? localPreviewPath(href) : undefined;
    if (filePath && preview.threadId) {
      const path = relativeToFile(filePath, baseFile);
      return (
        <ImageLinkContext value={true}>
          <a
            href={localPreviewUrl(preview.threadId, path)}
            className="local-file-link"
            title={title || t('preview:preview_file', { v0: path })}
            onClick={(event) => {
              event.preventDefault();
              preview.open(path);
            }}
          >
            {children}
          </a>
        </ImageLinkContext>
      );
    }
    const imagePath = href ? localImagePath(href) : undefined;
    const path = imagePath ? relativeToFile(imagePath, baseFile) : undefined;
    if (path && threadId) {
      return (
        <ImageLinkContext value={true}>
          <ControlHint asChild content={title || t('common:preview_image', { v0: path })}>
            <a
              href={localImageUrl(threadId, path)}
              className="local-image-link"
              onClick={(event) => {
                event.preventDefault();
                open({
                  path,
                  label:
                    typeof children === 'string'
                      ? children
                      : path.split('/').at(-1) || t('common:image'),
                });
              }}
            >
              {children}
            </a>
          </ControlHint>
        </ImageLinkContext>
      );
    }
    return (
      <ImageLinkContext value={true}>
        <ControlHint asChild content={title}>
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        </ControlHint>
      </ImageLinkContext>
    );
  },
  img: function MarkdownImage({ src, alt, title }) {
    const linked = useContext(ImageLinkContext);
    const baseFile = useContext(BaseFileContext);
    const imagePath = typeof src === 'string' ? localImagePath(src, true) : undefined;
    const path = imagePath ? relativeToFile(imagePath, baseFile) : undefined;
    return path ? (
      <LocalImage key={path} path={path} alt={alt} title={title} interactive={!linked} />
    ) : (
      <RemoteImage
        key={String(src)}
        src={typeof src === 'string' ? src : ''}
        alt={alt}
        title={title}
        interactive={!linked}
      />
    );
  },
  table: ({ children }) => (
    <div
      className="markdown-table-scroll"
      role="region"
      aria-label={t('preview:table')}
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  ),
};

const assistantMarkdownComponents: Components = {
  ...markdownComponents,
  p: function Paragraph({ node, ...props }) {
    const { text } = useContext(SourceContext);
    const { threadId } = useFilePreview();
    const { start, end } = node?.position ?? {};
    // Read the original standalone paragraph so Markdown in reference fields stays literal.
    const source =
      start?.column === 1 && start.offset !== undefined && end?.offset !== undefined
        ? text.slice(start.offset, end.offset)
        : '';
    const visualization = threadId ? parseVisualizationReference(source) : undefined;
    if (threadId && visualization)
      return (
        <VisualizationBlock
          key={`${threadId}:${visualization.path}`}
          threadId={threadId}
          reference={visualization}
        />
      );
    const title = browserCompletionTitle(source);
    if (!title) return <p {...props} />;
    return (
      <p className="browser-completion">
        <Globe size={16} strokeWidth={1.7} aria-hidden="true" />
        <span>{title}</span>
      </p>
    );
  },
};

export function MarkdownContent({
  text,
  baseFile,
  streaming = false,
  assistantMessage = false,
  externalBaseUrl,
}: {
  text: string;
  baseFile?: string;
  streaming?: boolean;
  assistantMessage?: boolean;
  externalBaseUrl?: string;
}) {
  return (
    <BaseFileContext value={baseFile}>
      <SourceContext value={{ text, streaming }}>
        <div className="markdown">
          <Markdown
            skipHtml
            remarkPlugins={[remarkGfm]}
            components={assistantMessage ? assistantMarkdownComponents : markdownComponents}
            urlTransform={
              externalBaseUrl
                ? (url) => {
                    const safe = defaultUrlTransform(url);
                    if (!safe) return '';
                    try {
                      return new URL(safe, externalBaseUrl).href;
                    } catch {
                      return '';
                    }
                  }
                : transformUrl
            }
          >
            {text}
          </Markdown>
        </div>
      </SourceContext>
    </BaseFileContext>
  );
}
