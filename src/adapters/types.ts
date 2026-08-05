/** A discoverable, addressable agent session on this machine. */
export interface SessionInfo {
  /** Agent kind: 'claude' | 'codex' | ... */
  agent: string;
  /** Stable session/thread id used for resume-based delivery. */
  sessionId: string;
  /** Human-readable title used for @-target matching and UI display. */
  title: string;
  /** Project working directory. Claude resume MUST run with this cwd; '' if unknown. */
  cwd: string;
  /** Last activity, epoch ms. */
  lastActiveAt: number;
}

export interface AgentAdapter {
  readonly agent: string;
  listSessions(): Promise<SessionInfo[]>;
}
