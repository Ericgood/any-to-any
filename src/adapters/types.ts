/** A discoverable, addressable agent session (local, or on a paired LAN device). */
export interface SessionInfo {
  /** Agent kind: 'claude' | 'codex' | ... */
  agent: string;
  /** Device name for remote sessions; unset = this machine. */
  device?: string;
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

export interface DeliveryResult {
  ok: boolean;
  /** Target agent's stdout for the injected turn (reply extraction source). */
  output?: string;
  error?: string;
  /** false = terminal failure, do not auto-retry (e.g. a timeout — the turn
   *  already ran on the target, so re-running it just duplicates the work). */
  retry?: boolean;
}

export interface DeliveryAdapter extends AgentAdapter {
  /** Inject an envelope into the target session (resume-based in Phase 1). */
  deliver(session: SessionInfo, envelope: string): Promise<DeliveryResult>;
}

/** Injectable subprocess runner so adapter contract tests never spawn real CLIs. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;
