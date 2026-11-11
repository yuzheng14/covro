# Read-only x64 Windows probe. Uses system DLLs through in-memory P/Invoke metadata.
# No Add-Type, compiler, saved assembly, elevation, debug privilege or policy changes.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$script:ProbeStage = 'startup'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

function Fail-Query { throw 'Windows process metadata is unavailable' }
function Native([string]$name, [object[]]$values) {
    return $script:NativeApi.GetMethod($name).Invoke($null, $values)
}
function Bind-Native([string]$name, [string]$library, [Type]$result, [Type[]]$parameters) {
    $dll = [IO.Path]::Combine([Environment]::SystemDirectory, $library)
    $method = $script:NativeBuilder.DefinePInvokeMethod(
        $name, $dll, $name,
        [Reflection.MethodAttributes]'Public,Static,PinvokeImpl',
        [Reflection.CallingConventions]::Standard, $result, $parameters,
        [Runtime.InteropServices.CallingConvention]::Winapi,
        [Runtime.InteropServices.CharSet]::None)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
}
function Allocate([int]$size) {
    if ($size -lt 1 -or $size -gt 16777216) { Fail-Query }
    $memory = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $size), 0, $memory, $size)
    return $memory
}
function Free-Memory([IntPtr]$memory) {
    if ($memory -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($memory) }
}
function Pointer([long]$address) {
    if ($address -lt 65536 -or $address -gt 140737488355327) { Fail-Query }
    return [IntPtr]$address
}
function Alive([IntPtr]$handle) { return (Native 'WaitForSingleObject' @($handle, [uint32]0)) -eq 258 }
function Birth([IntPtr]$handle) {
    $memory = Allocate 32
    try {
        if (-not (Native 'GetProcessTimes' @($handle, $memory, [IntPtr]::Add($memory,8), [IntPtr]::Add($memory,16), [IntPtr]::Add($memory,24)))) { Fail-Query }
        $ticks = [Runtime.InteropServices.Marshal]::ReadInt64($memory,0)
        if ($ticks -lt 1 -or -not (Alive $handle)) { Fail-Query }
        return $ticks
    } finally { Free-Memory $memory }
}
function Open-Identity([int]$targetId, [uint32]$access) {
    $handle = Native 'OpenProcess' @($access, $false, [uint32]$targetId)
    if ($handle -eq [IntPtr]::Zero) { Fail-Query }
    try { return @{ Handle=$handle; Birth=(Birth $handle) } }
    catch { $null = Native 'CloseHandle' @($handle); throw }
}
function Parent-Table {
    $snapshot = Native 'CreateToolhelp32Snapshot' @([uint32]2, [uint32]0)
    if ($snapshot -eq [IntPtr](-1)) { Fail-Query }
    $memory = Allocate 568 # PROCESSENTRY32W, x64
    try {
        $rows = @{}
        [Runtime.InteropServices.Marshal]::WriteInt32($memory,568)
        $next = Native 'Process32FirstW' @($snapshot,$memory)
        if (-not $next) { Fail-Query }
        while ($next) {
            $targetId = [Runtime.InteropServices.Marshal]::ReadInt32($memory,8)
            $parentId = [Runtime.InteropServices.Marshal]::ReadInt32($memory,32)
            if ($targetId -gt 0 -and $parentId -ge 0) { $rows[$targetId] = $parentId }
            if ($rows.Count -gt 131072) { Fail-Query }
            $next = Native 'Process32NextW' @($snapshot,$memory)
        }
        return $rows
    } finally { Free-Memory $memory; $null = Native 'CloseHandle' @($snapshot) }
}
function Is-Descendant([int]$targetId, [int]$rootId, $parents) {
    $visited = New-Object 'Collections.Generic.HashSet[int]'
    while ($targetId -gt 0 -and $visited.Add($targetId)) {
        if ($targetId -eq $rootId) { return $true }
        if (-not $parents.ContainsKey($targetId)) { return $false }
        $targetId = $parents[$targetId]
    }
    return $false
}
function U16([byte[]]$bytes, [int]$offset) { return [BitConverter]::ToUInt16($bytes,$offset) }
function Address([byte[]]$bytes, [int]$offset) { return [BitConverter]::ToInt64($bytes,$offset) }
function Read-Remote([IntPtr]$handle, [long]$address, [int]$size) {
    $contextStage=$script:ProbeStage; $script:ProbeStage='remote_pointer'
    $pointer = Pointer $address
    if ($size -lt 1 -or $size -gt 65536) { Fail-Query }
    $memory = Allocate $size
    $count = Allocate 8
    try {
        $script:ProbeStage='remote_read'
        if (-not (Native 'ReadProcessMemory' @($handle,$pointer,$memory,[UIntPtr]::new([uint64]$size),$count))) { Fail-Query }
        $script:ProbeStage='remote_count'
        if ([Runtime.InteropServices.Marshal]::ReadInt64($count) -ne $size) { Fail-Query }
        $bytes = New-Object byte[] $size
        [Runtime.InteropServices.Marshal]::Copy($memory,$bytes,0,$size)
        $script:ProbeStage=$contextStage
        return ,$bytes
    } finally {
        [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $size),0,$memory,$size)
        Free-Memory $memory; Free-Memory $count
    }
}
function Read-Environment([IntPtr]$handle, [long]$address) {
    $script:ProbeStage = 'environment'
    $null = Pointer $address
    if (($address % 2) -ne 0) { Fail-Query }
    $bytes = New-Object byte[] 1048576
    $characters = $null
    $region = Allocate 48 # MEMORY_BASIC_INFORMATION, x64
    try {
        $total = 0; $end = -1; $previousZero = $false
        while ($total -lt $bytes.Length -and $end -lt 0) {
            $cursor = $address + $total
            $size = Native 'VirtualQueryEx' @($handle,(Pointer $cursor),$region,[UIntPtr]::new([uint64]48))
            if ($size.ToUInt64() -ne 48) { Fail-Query }
            $base = [Runtime.InteropServices.Marshal]::ReadInt64($region,0)
            $length = [Runtime.InteropServices.Marshal]::ReadInt64($region,24)
            $state = [Runtime.InteropServices.Marshal]::ReadInt32($region,32)
            $protect = [Runtime.InteropServices.Marshal]::ReadInt32($region,36)
            if ($state -ne 4096 -or ($protect -band 257) -ne 0 -or $length -lt 1 -or $base -gt $cursor -or $base + $length -le $cursor) { Fail-Query }
            $part = [int][Math]::Min(4096,[Math]::Min($bytes.Length-$total,$base+$length-$cursor))
            $part -= $part % 2
            if ($part -lt 2) { Fail-Query }
            $chunk = Read-Remote $handle $cursor $part
            try { [Array]::Copy($chunk,0,$bytes,$total,$part) }
            finally { [Array]::Clear($chunk,0,$chunk.Length) }
            $units=New-Object char[] ($part/2)
            try {
                [Buffer]::BlockCopy($bytes,$total,$units,0,$part)
                for ($index=0; $index -lt $units.Length; $index++) {
                    $zero = $units[$index] -eq [char]0
                    if ($zero -and $previousZero) { $end=$total+$index*2+2; break }
                    $previousZero = $zero
                }
            } finally { [Array]::Clear($units,0,$units.Length) }
            $total += $part
        }
        if ($end -lt 0) { Fail-Query }
        $markers = @{}
        # Mutable UTF-16 units keep unrelated environment values out of strings.
        # Array.IndexOf scans NUL boundaries in the system runtime, not PS functions.
        $characters=New-Object char[] ($end/2)
        [Buffer]::BlockCopy($bytes,0,$characters,0,$end)
        $keys = @('CODEX_THREAD_ID=','CODEX_TOOL_CALL_ID=')
        $offset = 0
        while ($offset -lt $characters.Length -and $characters[$offset] -ne [char]0) {
            $entryEnd = [Array]::IndexOf([Array]$characters,[char]0,$offset)
            if ($entryEnd -lt $offset) { Fail-Query }
            foreach ($key in $keys) {
                $matches = $entryEnd-$offset -ge $key.Length
                for ($index=0; $matches -and $index -lt $key.Length; $index++) { $matches = $characters[$offset+$index] -ceq $key[$index] }
                if (-not $matches) { continue }
                $count = $entryEnd-$offset-$key.Length
                if ($markers.ContainsKey($key) -or $count -lt 1 -or $count -gt 160) { Fail-Query }
                $value = New-Object Text.StringBuilder
                for ($index=$offset+$key.Length; $index -lt $entryEnd; $index++) {
                    $character = [int]$characters[$index]
                    if (-not (($character -ge 48 -and $character -le 57) -or ($character -ge 65 -and $character -le 90) -or ($character -ge 97 -and $character -le 122) -or $character -eq 45 -or $character -eq 95)) { Fail-Query }
                    $null = $value.Append([char]$character)
                }
                $markers[$key] = $value.ToString()
            }
            $offset = $entryEnd+1
        }
        if ($markers.Count -ne 2) { Fail-Query }
        return @{ thread=$markers[$keys[0]]; call=$markers[$keys[1]] }
    } finally {
        if ($null -ne $characters) { [Array]::Clear($characters,0,$characters.Length) }
        [Array]::Clear($bytes,0,$bytes.Length); Free-Memory $region
    }
}
function Equal-Bytes([byte[]]$left,[byte[]]$right) {
    if ($left.Length -ne $right.Length) { return $false }
    for ($index=0; $index -lt $left.Length; $index++) { if ($left[$index] -ne $right[$index]) { return $false } }
    return $true
}
function Current-Directory([IntPtr]$processHandle,[long]$rawHandle) {
    $script:ProbeStage = 'cwd_duplicate'
    # RTL curdir reserves the low two handle bits for flags.
    $rawHandle = $rawHandle -band (-4L)
    if ($rawHandle -le 0) { Fail-Query }
    $duplicate = Allocate 8; $memory = Allocate 65536; $attributes = Allocate 24
    $directory = [IntPtr]::Zero
    try {
        if (-not (Native 'DuplicateHandle' @($processHandle,[IntPtr]$rawHandle,(Native 'GetCurrentProcess' @()),$duplicate,[uint32]0,$false,[uint32]2))) { Fail-Query }
        $directory = [Runtime.InteropServices.Marshal]::ReadIntPtr($duplicate)
        $script:ProbeStage = 'cwd_attributes'
        # The inherited curdir handle need not grant FILE_READ_ATTRIBUTES.
        # FileStandardInfo only requires an open handle, unlike FileBasicInfo.
        if (-not (Native 'GetFileInformationByHandleEx' @($directory,[int]1,$attributes,[uint32]24))) { Fail-Query }
        if ([Runtime.InteropServices.Marshal]::ReadByte($attributes,21) -ne 1 -or [Runtime.InteropServices.Marshal]::ReadByte($attributes,20) -ne 0) { Fail-Query }
        $script:ProbeStage = 'cwd_path'
        $size = Native 'GetFinalPathNameByHandleW' @($directory,$memory,[uint32]32768,[uint32]0)
        if ($size -lt 1 -or $size -ge 32768) { Fail-Query }
        $path = [Runtime.InteropServices.Marshal]::PtrToStringUni($memory,[int]$size)
        if ($path.StartsWith('\\?\')) { $path=$path.Substring(4) }
        if ($path -notmatch '^[A-Za-z]:\\') { Fail-Query }
        $drive = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($path.Substring(0,3))
        try { $kind = Native 'GetDriveTypeW' @($drive) } finally { Free-Memory $drive }
        if ($kind -notin @(2,3,6)) { Fail-Query } # Local drive letters only; no UNC/network probing.
        return $path
    } finally {
        if ($directory -ne [IntPtr]::Zero) { $null=Native 'CloseHandle' @($directory) }
        Free-Memory $duplicate; Free-Memory $memory; Free-Memory $attributes
    }
}
function Process-Identity([int]$targetId,[int]$parentId) {
    $script:ProbeStage = 'process_open'
    $opened=Open-Identity $targetId ([uint32]0x00100450) # query + VM read + duplicate handle + synchronize
    $basic=Allocate 48; $size=Allocate 4; $machines=Allocate 4
    try {
        $script:ProbeStage = 'process_arch'
        if (-not (Native 'IsWow64Process2' @($opened.Handle,$machines,[IntPtr]::Add($machines,2))) -or [Runtime.InteropServices.Marshal]::ReadInt16($machines,0) -ne 0 -or ([Runtime.InteropServices.Marshal]::ReadInt16($machines,2) -band 65535) -ne 0x8664) { Fail-Query }
        if ((Native 'NtQueryInformationProcess' @($opened.Handle,[int]0,$basic,[uint32]48,$size)) -ne 0 -or [Runtime.InteropServices.Marshal]::ReadInt32($size) -ne 48 -or [Runtime.InteropServices.Marshal]::ReadInt64($basic,32) -ne $targetId -or [Runtime.InteropServices.Marshal]::ReadInt64($basic,40) -ne $parentId) { Fail-Query }
        $script:ProbeStage = 'process_parameters'
        $peb=[Runtime.InteropServices.Marshal]::ReadInt64($basic,8)
        $pebPointer=Read-Remote $opened.Handle ($peb+32) 8
        $parameters=Address $pebPointer 0
        $script:ProbeStage = 'parameters_read'
        $before=Read-Remote $opened.Handle $parameters 144
        $maximum=[BitConverter]::ToUInt32($before,0); $length=[BitConverter]::ToUInt32($before,4)
        $script:ProbeStage = 'parameters_length'
        if ($length -lt 136 -or $maximum -lt $length -or $maximum -gt 1048576) { Fail-Query }
        $script:ProbeStage = 'parameters_flags'
        if (([BitConverter]::ToUInt32($before,8) -band 1) -ne 1) { Fail-Query }
        $script:ProbeStage = 'parameters_cwd'
        if ((U16 $before 56) -gt (U16 $before 58) -or ((U16 $before 56) % 2) -ne 0) { Fail-Query }
        $markers=Read-Environment $opened.Handle (Address $before 128)
        $cwd=Current-Directory $opened.Handle (Address $before 72)
        $script:ProbeStage = 'process_stability'
        $after=Read-Remote $opened.Handle $parameters 144
        $afterPointer=Read-Remote $opened.Handle ($peb+32) 8
        if (-not (Equal-Bytes $before $after) -or -not (Equal-Bytes $pebPointer $afterPointer) -or (Birth $opened.Handle) -ne $opened.Birth) { Fail-Query }
        return @{pid=$targetId;parent=$parentId;birth=$opened.Birth.ToString([Globalization.CultureInfo]::InvariantCulture);cwd=$cwd;thread=$markers.thread;call=$markers.call}
    } finally {
        $null=Native 'CloseHandle' @($opened.Handle)
        Free-Memory $basic; Free-Memory $size; Free-Memory $machines
    }
}
function Tcp-Rows([int]$ownerId,[int]$requiredState) {
    $script:ProbeStage='tcp'
    $tableClass=3 # TCP_TABLE_OWNER_PID_LISTENER
    if ($requiredState -eq 5) { $tableClass=4 } # TCP_TABLE_OWNER_PID_CONNECTIONS
    foreach ($family in @(2,23)) {
        $size=Allocate 4; $memory=[IntPtr]::Zero
        try {
            $status=Native 'GetExtendedTcpTable' @([IntPtr]::Zero,$size,$false,[uint32]$family,$tableClass,[uint32]0)
            if ($family -eq 23 -and $status -eq 50) { continue }
            if ($status -ne 122) { Fail-Query }
            $success=$false
            for ($attempt=0; $attempt -lt 3; $attempt++) {
                $capacity=[Runtime.InteropServices.Marshal]::ReadInt32($size)
                if ($capacity -lt 4 -or $capacity -gt 16777216) { Fail-Query }
                Free-Memory $memory; $memory=Allocate $capacity
                $status=Native 'GetExtendedTcpTable' @($memory,$size,$false,[uint32]$family,$tableClass,[uint32]0)
                if ($status -eq 0) { $success=$true; break }
                if ($status -ne 122) { Fail-Query }
            }
            if (-not $success) { Fail-Query }
            $count=[Runtime.InteropServices.Marshal]::ReadInt32($memory)
            $rowSize=24; if ($family -eq 23) { $rowSize=56 }
            if ($count -lt 0 -or $count -gt 131072 -or 4+$count*$rowSize -gt $capacity) { Fail-Query }
            for ($index=0; $index -lt $count; $index++) {
                $row=[IntPtr]::Add($memory,4+$index*$rowSize)
                $localOffset=4; $remoteOffset=12; $portOffset=8; $remotePortOffset=16; $stateOffset=0; $ownerOffset=20; $addressSize=4
                if ($family -eq 23) { $localOffset=0; $remoteOffset=24; $portOffset=20; $remotePortOffset=44; $stateOffset=48; $ownerOffset=52; $addressSize=16 }
                $state=[Runtime.InteropServices.Marshal]::ReadInt32($row,$stateOffset)
                $targetId=[Runtime.InteropServices.Marshal]::ReadInt32($row,$ownerOffset)
                if ($state -ne $requiredState -or ($ownerId -gt 0 -and $targetId -ne $ownerId)) { continue }
                $local=New-Object byte[] $addressSize; $remote=New-Object byte[] $addressSize
                [Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($row,$localOffset),$local,0,$addressSize)
                [Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($row,$remoteOffset),$remote,0,$addressSize)
                $localIp=[Net.IPAddress]::new([byte[]]$local); $remoteIp=[Net.IPAddress]::new([byte[]]$remote)
                if ($localIp.IsIPv4MappedToIPv6) { $localIp=$localIp.MapToIPv4() }
                if ($remoteIp.IsIPv4MappedToIPv6) { $remoteIp=$remoteIp.MapToIPv4() }
                $hostAddress=$localIp.ToString(); $remoteAddress=$remoteIp.ToString()
                if ($hostAddress -notin @('0.0.0.0','::','127.0.0.1','::1')) { continue }
                $port=[int][Runtime.InteropServices.Marshal]::ReadByte($row,$portOffset)*256+[int][Runtime.InteropServices.Marshal]::ReadByte($row,$portOffset+1)
                $remotePort=[int][Runtime.InteropServices.Marshal]::ReadByte($row,$remotePortOffset)*256+[int][Runtime.InteropServices.Marshal]::ReadByte($row,$remotePortOffset+1)
                @{pid=$targetId;host=$hostAddress;remote=$remoteAddress;port=$port;remotePort=$remotePort;state=$state}
            }
        } finally { Free-Memory $size; Free-Memory $memory }
    }
}
function Snapshot([int]$rootId) {
    $script:ProbeStage = 'snapshot'
    $handles=@{}
    function Cached([int]$targetId) {
        if (-not $handles.ContainsKey($targetId)) { $handles[$targetId]=Open-Identity $targetId ([uint32]0x00101000) }
        return $handles[$targetId]
    }
    try {
        $root=Cached $rootId
        $parents=Parent-Table
        $tcp=@(Tcp-Rows 0 2 | Where-Object { $_.pid -ne $rootId -and (Is-Descendant $_.pid $rootId $parents) })
        if ($tcp.Count -gt 4096) { Fail-Query }
        $identities=@{}; $diagnostics=@{}
        foreach ($targetId in @($tcp | ForEach-Object {$_.pid} | Select-Object -Unique)) {
            if ($identities.Count -ge 256) { Fail-Query }
            try {
                $script:ProbeStage = 'ancestry'
                $current=[int]$targetId; $childBirth=[long]::MaxValue
                while ($current -ne $rootId) {
                    $entry=Cached $current
                    if ($entry.Birth -gt $childBirth -or -not (Alive $entry.Handle)) { Fail-Query }
                    $childBirth=$entry.Birth; $current=$parents[$current]
                }
                if ($root.Birth -gt $childBirth) { Fail-Query }
                $identity=Process-Identity $targetId $parents[$targetId]
                if ([long]::Parse($identity.birth) -ne (Cached $targetId).Birth) { Fail-Query }
                # Select-Object can wrap numeric keys in PSObject; keep kernel IDs Int32.
                $identities[[int]$targetId]=$identity
            } catch { # Only fixed stage codes, never an exception message or raw environment.
                if (-not $diagnostics.ContainsKey($script:ProbeStage)) { $diagnostics[$script:ProbeStage]=0 }
                $diagnostics[$script:ProbeStage]++
            }
        }
        foreach ($entry in $handles.Values) { if (-not (Alive $entry.Handle)) { Fail-Query } }
        $listeners=@(foreach ($row in $tcp) {
            if ($identities.ContainsKey([int]$row.pid)) {
                $hostAddress=$row.host
                if ($hostAddress -eq '0.0.0.0') {$hostAddress='127.0.0.1'}
                if ($hostAddress -eq '::') {$hostAddress='::1'}
                @{pid=$row.pid;port=$row.port;host=$hostAddress}
            }
        })
        return @{root=$rootId;rootBirth=$root.Birth.ToString([Globalization.CultureInfo]::InvariantCulture);processes=@($identities.Values);listeners=$listeners;diagnostics=$diagnostics}
    } finally { foreach ($entry in $handles.Values) { $null=Native 'CloseHandle' @($entry.Handle) } }
}
function Connected([int]$targetId,[int]$port,[int]$clientPort,[string]$hostAddress) {
    $opened=Open-Identity $targetId ([uint32]0x00101000)
    try {
        $matches=@(Tcp-Rows $targetId 5 | Where-Object { $_.port -eq $port -and $_.remotePort -eq $clientPort -and $_.host -eq $hostAddress -and $_.remote -eq $hostAddress })
        return @{connected=($matches.Count -gt 0 -and (Birth $opened.Handle) -eq $opened.Birth)}
    } finally { $null=Native 'CloseHandle' @($opened.Handle) }
}
try {
    if ([IntPtr]::Size -ne 8 -or $ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Fail-Query }
    $assemblyName=New-Object Reflection.AssemblyName('CovroPreviewNative')
    $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module=$assembly.DefineDynamicModule('api')
    $script:NativeBuilder=$module.DefineType('CovroPreviewNative',[Reflection.TypeAttributes]'Public,Sealed,Abstract')
    Bind-Native 'OpenProcess' 'kernel32.dll' ([IntPtr]) @([uint32],[bool],[uint32])
    Bind-Native 'CloseHandle' 'kernel32.dll' ([bool]) @([IntPtr])
    Bind-Native 'WaitForSingleObject' 'kernel32.dll' ([uint32]) @([IntPtr],[uint32])
    Bind-Native 'GetCurrentProcess' 'kernel32.dll' ([IntPtr]) @()
    Bind-Native 'GetProcessTimes' 'kernel32.dll' ([bool]) @([IntPtr],[IntPtr],[IntPtr],[IntPtr],[IntPtr])
    Bind-Native 'CreateToolhelp32Snapshot' 'kernel32.dll' ([IntPtr]) @([uint32],[uint32])
    Bind-Native 'Process32FirstW' 'kernel32.dll' ([bool]) @([IntPtr],[IntPtr])
    Bind-Native 'Process32NextW' 'kernel32.dll' ([bool]) @([IntPtr],[IntPtr])
    Bind-Native 'ReadProcessMemory' 'kernel32.dll' ([bool]) @([IntPtr],[IntPtr],[IntPtr],[UIntPtr],[IntPtr])
    Bind-Native 'VirtualQueryEx' 'kernel32.dll' ([UIntPtr]) @([IntPtr],[IntPtr],[IntPtr],[UIntPtr])
    Bind-Native 'IsWow64Process2' 'kernel32.dll' ([bool]) @([IntPtr],[IntPtr],[IntPtr])
    Bind-Native 'DuplicateHandle' 'kernel32.dll' ([bool]) @([IntPtr],[IntPtr],[IntPtr],[IntPtr],[uint32],[bool],[uint32])
    Bind-Native 'GetFileInformationByHandleEx' 'kernel32.dll' ([bool]) @([IntPtr],[int],[IntPtr],[uint32])
    Bind-Native 'GetFinalPathNameByHandleW' 'kernel32.dll' ([uint32]) @([IntPtr],[IntPtr],[uint32],[uint32])
    Bind-Native 'GetDriveTypeW' 'kernel32.dll' ([uint32]) @([IntPtr])
    Bind-Native 'NtQueryInformationProcess' 'ntdll.dll' ([int]) @([IntPtr],[int],[IntPtr],[uint32],[IntPtr])
    Bind-Native 'GetExtendedTcpTable' 'iphlpapi.dll' ([uint32]) @([IntPtr],[IntPtr],[bool],[uint32],[int],[uint32])
    $script:NativeApi=$script:NativeBuilder.CreateType()
    [Console]::Out.WriteLine('{"ready":true}')
    while ($null -ne ($lineText=[Console]::ReadLine())) {
        $requestId=0
        try {
            if ($lineText.Length -gt 4096) { Fail-Query }
            $requestRecord=ConvertFrom-Json $lineText
            $requestId=[int]$requestRecord.id
            if ($requestId -lt 1) { Fail-Query }
            if ($requestRecord.method -eq 'snapshot') {
                $rootId=[int]$requestRecord.root
                if ($rootId -lt 1) { Fail-Query }
                $result=Snapshot $rootId
            } elseif ($requestRecord.method -eq 'connected') {
                $targetId=[int]$requestRecord.pid; $port=[int]$requestRecord.port; $clientPort=[int]$requestRecord.clientPort
                $hostAddress=[string]$requestRecord.host
                if ($targetId -lt 1 -or $port -lt 1 -or $port -gt 65535 -or $clientPort -lt 1 -or $clientPort -gt 65535 -or $hostAddress -notin @('127.0.0.1','::1')) { Fail-Query }
                $result=Connected $targetId $port $clientPort $hostAddress
            } else { Fail-Query }
            [Console]::Out.WriteLine((ConvertTo-Json -Depth 8 -Compress @{id=$requestId;ok=$true;result=$result}))
        } catch { [Console]::Out.WriteLine((ConvertTo-Json -Compress @{id=$requestId;ok=$false;error='query_failed';stage=$script:ProbeStage})) }
    }
} catch {
    [Console]::Out.WriteLine('{"ready":false}')
    exit 1
}
