
export interface SessionState {
  isActive: boolean;
  isMuted: boolean;
  isScreenSharing: boolean;
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string | null;
}

export interface TranscriptionItem {
  type: 'user' | 'model';
  text: string;
  timestamp: number;
}
