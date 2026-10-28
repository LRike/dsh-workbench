/** Identity generation for workbench entities. */
import { randomUUID } from 'node:crypto';

export const newId = (prefix) => prefix + '_' + randomUUID();
export const newProjectId = () => newId('p');
export const newUnitId = () => newId('u');
export const newDecisionId = () => newId('d');
export const newAcceptanceId = () => newId('ac');
export const newSessionId = () => 'session-' + randomUUID();
export const issueCode = (n) => 'WB-' + n;
