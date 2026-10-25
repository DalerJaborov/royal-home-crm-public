import { describe, expect, it } from 'vitest';
import { groupAgencyLabelCoincidences } from '../src/lib/agencyLabelPreview.js';
const date = new Date('2026-10-25T10:00:00Z');
const row = (id: string, client: string, label: string, agent = 'agent') => ({ id, entityId: client, meta: { competitorName: label, assignedAgentId: agent }, createdAt: date });
describe('exact entered agency labels are not company identity or a verdict', () => {
  it('groups trimmed Unicode-normalized case variants for distinct clients and preserves originals and source IDs', () => {
    const groups = groupAgencyLabelCoincidences([row('a', 'one', '  АГЕНТСТВО  '), row('b', 'two', 'агентство')]);
    expect(groups).toEqual([{ agentId: 'agent', originalLabels: ['АГЕНТСТВО', 'агентство'], distinctClients: 2, sourceIds: ['a', 'b'], clientIds: ['one', 'two'], latestAt: date.toISOString(), companyIdentity: 'UNKNOWN' }]);
  });
  it('does not turn repeated refusal clicks for one client into two clients', () => {
    expect(groupAgencyLabelCoincidences([row('a', 'one', 'Agency'), row('b', 'one', 'Agency')])).toEqual([]);
  });
  it('does not merge aliases, spacing, different agents or narrative-only mentions', () => {
    expect(groupAgencyLabelCoincidences([row('a', 'one', 'Agency X'), row('b', 'two', 'Agency  X'), row('c', 'three', 'Agency X', 'other'),
      { id: 'd', entityId: 'four', meta: { comment: 'Агентство-конкурент: Agency X', assignedAgentId: 'agent' }, createdAt: date }])).toEqual([]);
  });
  it('requires actual producer attribution, never treats the clicking actor as the responsible agent', () => {
    expect(groupAgencyLabelCoincidences([{ id: 'a', entityId: 'one', meta: { competitorName: 'Agency', agentId: 'agent' }, createdAt: date }, row('b', 'two', 'Agency')])).toEqual([]);
  });
});
