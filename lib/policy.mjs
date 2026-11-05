// Central authorization policy. Every access decision goes through can()/teamCan().
// Pure functions: no I/O, fully unit-testable.

export const WORKSPACE_ROLES = ['viewer', 'editor', 'owner'];
export const TEAM_ROLES = ['member', 'owner'];

const WORKSPACE_MIN_ROLE = {
  'workspace.read': 'viewer',
  'workspace.chat': 'viewer',
  'workspace.write': 'editor',
  'workspace.agent': 'editor',
  'workspace.invite': 'owner',
  'workspace.manage': 'owner',
  'workspace.github': 'owner'
};
const TEAM_MIN_ROLE = { 'team.read': 'member', 'team.invite': 'owner', 'team.manage': 'owner' };

const rank = (list, role) => list.indexOf(role);

export function workspaceRole(project, user) {
  if (!project || !user) return null;
  if (user.role === 'admin') return 'owner';
  return project.members?.[user.id] ?? null;
}

const FROZEN_DENIED = new Set(['workspace.write', 'workspace.agent']);

export function can(user, action, project) {
  const min = WORKSPACE_MIN_ROLE[action];
  if (!min) return false; // unknown actions are denied
  if (project?.frozen && FROZEN_DENIED.has(action)) return false; // event deadline freeze
  const role = workspaceRole(project, user);
  return role !== null && rank(WORKSPACE_ROLES, role) >= rank(WORKSPACE_ROLES, min);
}

export function teamRole(team, user) {
  if (!team || !user) return null;
  if (user.role === 'admin') return 'owner';
  return team.members?.[user.id] ?? null;
}

export function teamCan(user, action, team) {
  const min = TEAM_MIN_ROLE[action];
  if (!min) return false;
  const role = teamRole(team, user);
  return role !== null && rank(TEAM_ROLES, role) >= rank(TEAM_ROLES, min);
}

export const isWorkspaceRole = (value) => WORKSPACE_ROLES.includes(value);
export const isTeamRole = (value) => TEAM_ROLES.includes(value);

// ---- event-level roles: organizer > judge > mentor > participant
export const EVENT_ROLES = ['participant', 'mentor', 'judge', 'organizer'];
const EVENT_ALLOWED = {
  'event.read': ['participant', 'mentor', 'judge', 'organizer'],
  'event.participate': ['participant'],
  'event.manage': ['organizer'],
  'event.dashboard': ['organizer'],
  'event.announce': ['organizer'],
  'event.mentor': ['mentor', 'organizer'],
  'event.judge': ['judge']
};
export function eventRole(event, user) {
  if (!event || !user) return null;
  if (user.role === 'admin') return 'organizer';
  return event.members?.[user.id] ?? null;
}
export function eventCan(user, action, event) {
  const allowed = EVENT_ALLOWED[action]; if (!allowed) return false;
  const role = eventRole(event, user); return role !== null && allowed.includes(role);
}
export const isEventRole = (value) => EVENT_ROLES.includes(value);
