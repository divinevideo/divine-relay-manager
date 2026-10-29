import { describe, it, expect } from 'vitest';
import { quarantineRestoreResult } from './event-visibility';
import type { SexualCase } from '../../shared/sexual-quarantine';
const caseState = (state: SexualCase['state'], recorded = true) => ({ state, goal: 'restore', decisionRecordedAt: recorded ? 1000 : undefined }) as SexualCase;
describe('scoped restore response', () => {
  it('requires both verified public restoration and the Reports projection', () => {
    expect(quarantineRestoreResult(caseState('restored'))).toMatchObject({ success: true, recorded: true });
    expect(quarantineRestoreResult(caseState('restored', false))).toMatchObject({ success: false, recorded: false, quarantineReleased: true });
    expect(quarantineRestoreResult(caseState('pending'))).toMatchObject({ success: false, recorded: false });
    expect(quarantineRestoreResult({ ...caseState('removed'), goal: 'remove' })).toMatchObject({ success: false, recorded: false });
  });
  it('reports remaining restrictions as a conflict with a successful scoped release', () => {
    expect(quarantineRestoreResult(caseState('restored_restricted'))).toMatchObject({
      success: false, recorded: true, conflict: true, quarantineReleased: true, remainingRestrictions: true,
    });
  });
});
