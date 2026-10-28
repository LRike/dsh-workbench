/**
 * Issue status vocabulary. Behaviour comes from the category, never from the
 * status name; six statuses map onto four fixed categories (concepts §6.1).
 */

/** @type {Record<string, 'unstarted'|'started'|'done'|'closed'>} */
export const STATUS_CATEGORY = {
  todo: 'unstarted',
  in_progress: 'started',
  blocked: 'started',
  in_review: 'started',
  done: 'done',
  cancelled: 'closed',
};

export const TERMINAL_STATUSES = new Set(['done', 'cancelled']);
/** Statuses a human may write through the generic status command (never done). */
export const HUMAN_WRITABLE_STATUSES = new Set(['todo', 'in_progress', 'blocked', 'in_review']);
/** Active board columns (terminal statuses never appear on the board). */
export const ACTIVE_STATUSES = ['todo', 'in_progress', 'blocked', 'in_review'];

/** Unit execution states. 'wrapping' = a session ended/went idle but nobody wrapped up yet. */
export const EXEC_STATES = new Set(['pending', 'running', 'wrapping', 'ended', 'failed']);
export const EXEC_ACTIVE = new Set(['pending', 'running', 'wrapping']);

export const categoryOf = (status) => STATUS_CATEGORY[status] || 'started';
export const isTerminal = (status) => TERMINAL_STATUSES.has(status);
