import type { AutoReviewView } from './types.js';

export interface GuardianDenial {
  id: string;
  turnId: string;
  review: AutoReviewView;
}
