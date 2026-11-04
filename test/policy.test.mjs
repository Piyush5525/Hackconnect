import test from 'node:test';
import assert from 'node:assert/strict';
import { can, teamCan, workspaceRole, WORKSPACE_ROLES } from '../lib/policy.mjs';

const project = { members: { o: 'owner', e: 'editor', v: 'viewer' } };
const users = { o: { id: 'o', role: 'user' }, e: { id: 'e', role: 'user' }, v: { id: 'v', role: 'user' }, x: { id: 'x', role: 'user' }, admin: { id: 'a', role: 'admin' } };
const expected = {
  'workspace.read': { o: 1, e: 1, v: 1, x: 0, admin: 1 },
  'workspace.chat': { o: 1, e: 1, v: 1, x: 0, admin: 1 },
  'workspace.write': { o: 1, e: 1, v: 0, x: 0, admin: 1 },
  'workspace.agent': { o: 1, e: 1, v: 0, x: 0, admin: 1 },
  'workspace.invite': { o: 1, e: 0, v: 0, x: 0, admin: 1 },
  'workspace.manage': { o: 1, e: 0, v: 0, x: 0, admin: 1 },
  'workspace.github': { o: 1, e: 0, v: 0, x: 0, admin: 1 }
};

for (const [action, matrix] of Object.entries(expected)) {
  for (const [who, allowed] of Object.entries(matrix)) {
    test(`${action} for ${who} => ${Boolean(allowed)}`, () => assert.equal(can(users[who], action, project), Boolean(allowed)));
  }
}

test('unknown actions, missing user, and missing project are denied', () => {
  assert.equal(can(users.o, 'workspace.nuke', project), false);
  assert.equal(can(null, 'workspace.read', project), false);
  assert.equal(can(users.o, 'workspace.read', null), false);
  assert.equal(workspaceRole(project, null), null);
});

test('role list is ordered least to most privileged', () => assert.deepEqual(WORKSPACE_ROLES, ['viewer', 'editor', 'owner']));

test('team permissions', () => {
  const t = { members: { o: 'owner', m: 'member' } };
  assert.equal(teamCan({ id: 'm', role: 'user' }, 'team.read', t), true);
  assert.equal(teamCan({ id: 'm', role: 'user' }, 'team.invite', t), false);
  assert.equal(teamCan({ id: 'o', role: 'user' }, 'team.invite', t), true);
  assert.equal(teamCan({ id: 'z', role: 'user' }, 'team.read', t), false);
  assert.equal(teamCan({ id: 'a', role: 'admin' }, 'team.manage', t), true);
  assert.equal(teamCan({ id: 'o', role: 'user' }, 'team.delete', t), false);
});
