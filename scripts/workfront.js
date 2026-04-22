/*
 * Workfront Client — Real API + WOA Agent Fallbacks
 *
 * Auth strategy (tries in order):
 *   1. IMS Bearer token (Adobe Cloud Workfront instances)
 *   2. Workfront API key (stored in localStorage)
 *   3. Simulated demo response (no auth needed)
 *
 * API: https://developers.workfront.com/api/
 * Base: https://{instance}.my.workfront.com/attask/api/v17.0/
 */

import { getToken } from './ims.js';

const WF_BASE = 'https://aemxsc.my.workfront.com';
const WF_API = `${WF_BASE}/attask/api/v17.0`;
const WF_APIKEY_STORAGE = 'ew-workfront-apikey';

/* ─── Auth ─── */

export function getApiKey() {
  return localStorage.getItem(WF_APIKEY_STORAGE) || '';
}

export function setApiKey(key) {
  if (key) localStorage.setItem(WF_APIKEY_STORAGE, key.trim());
  else localStorage.removeItem(WF_APIKEY_STORAGE);
}

export function hasApiKey() {
  return !!getApiKey();
}

let wfAuthMode = null; // 'ims' | 'apikey' | 'demo'

/**
 * Fetch with Workfront auth. Tries IMS token, then API key.
 * Returns null if neither works (caller falls back to demo).
 */
async function wfFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${WF_API}${path}`;
  const imsToken = getToken();
  const apiKey = getApiKey();

  // Try IMS token first
  if (imsToken && wfAuthMode !== 'apikey') {
    try {
      const resp = await fetch(url, {
        ...opts,
        headers: { Authorization: `Bearer ${imsToken}`, ...opts.headers },
      });
      if (resp.ok || resp.status === 404) {
        wfAuthMode = 'ims';
        return resp;
      }
      if (resp.status === 401 || resp.status === 403) {
        console.debug('[WF] IMS token rejected, trying API key...');
      }
    } catch { /* fall through */ }
  }

  // Try API key
  if (apiKey) {
    try {
      const sep = url.includes('?') ? '&' : '?';
      const resp = await fetch(`${url}${sep}apiKey=${apiKey}`, opts);
      if (resp.ok || resp.status === 404) {
        wfAuthMode = 'apikey';
        return resp;
      }
    } catch { /* fall through */ }
  }

  return null; // Both failed — caller uses demo fallback
}

/**
 * Check if Workfront API is reachable. Caches result.
 */
export async function checkConnection() {
  try {
    const resp = await wfFetch('/user?action=whoami');
    if (resp?.ok) {
      const data = await resp.json();
      wfAuthMode = wfAuthMode || 'ims';
      return {
        connected: true,
        mode: wfAuthMode,
        user: data.data?.name || data.data?.emailAddr || 'Unknown',
        userId: data.data?.ID || null,
      };
    }
  } catch { /* fall through */ }
  wfAuthMode = 'demo';
  return { connected: false, mode: 'demo' };
}

export function getAuthMode() { return wfAuthMode || 'demo'; }

/* ─── Projects ─── */

export async function listProjects(filters = {}) {
  const params = new URLSearchParams();
  params.set('$$LIMIT', String(filters.limit || 20));
  if (filters.status) params.set('status', filters.status);
  if (filters.groupID) params.set('groupID', filters.groupID);
  params.set('fields', 'name,status,percentComplete,plannedCompletionDate,owner:name,category:name,priority,condition');

  const resp = await wfFetch(`/proj/search?${params}`);
  if (!resp?.ok) return demoProjects();
  const data = await resp.json();
  return { source: 'live', projects: data.data || [] };
}

export async function getProject(projectId) {
  const resp = await wfFetch(`/proj/${projectId}?fields=name,status,percentComplete,plannedCompletionDate,owner:name,tasks:name,tasks:status,tasks:percentComplete,tasks:assignedTo:name`);
  if (!resp?.ok) return null;
  const data = await resp.json();
  return { source: 'live', project: data.data };
}

/* ─── Tasks ─── */

export async function listTasks(filters = {}) {
  const params = new URLSearchParams();
  params.set('$$LIMIT', String(filters.limit || 30));
  if (filters.projectID) params.set('projectID', filters.projectID);
  if (filters.status) params.set('status', filters.status);
  if (filters.assignedToID) params.set('assignedToID', filters.assignedToID);
  params.set('fields', 'name,status,percentComplete,priority,plannedCompletionDate,assignedTo:name,project:name');

  const resp = await wfFetch(`/task/search?${params}`);
  if (!resp?.ok) return demoTasks();
  const data = await resp.json();
  return { source: 'live', tasks: data.data || [] };
}

export async function createTask({ projectId, name, assignee, priority, description }) {
  // Try real API first
  const body = {
    name,
    projectID: projectId,
    description: description || '',
    priority: priorityToNum(priority),
  };

  const resp = await wfFetch('/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (resp?.ok) {
    const data = await resp.json();
    return {
      source: 'live',
      id: data.data?.ID,
      name: data.data?.name,
      status: data.data?.status,
      url: `${WF_BASE}/task/${data.data?.ID}`,
    };
  }

  // Webhook fallback
  if (hasWebhook()) {
    return createTaskViaWebhook({ projectId, name, assignee, priority, description });
  }

  // Demo fallback
  return {
    source: 'demo',
    id: `TSK-${Math.floor(Math.random() * 9000 + 1000)}`,
    projectId: projectId || 'PRJ-2847',
    name,
    assignee,
    priority: priority || 'Normal',
    status: 'New',
    created: new Date().toISOString(),
    url: `${WF_BASE}/task/view`,
  };
}

export async function updateTask(taskId, fields) {
  const resp = await wfFetch(`/task/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!resp?.ok) return { source: 'demo', updated: true, taskId, fields };
  const data = await resp.json();
  return { source: 'live', task: data.data };
}

/* ─── Approvals ─── */

export async function listApprovals(filters = {}) {
  const params = new URLSearchParams();
  params.set('$$LIMIT', String(filters.limit || 20));
  if (filters.status) params.set('status', filters.status);
  params.set('fields', 'approvalObj:objCode,approvalObj:name,status,approver:name,requestDate');

  const resp = await wfFetch(`/approval/search?${params}`);
  if (!resp?.ok) return demoApprovals();
  const data = await resp.json();
  return { source: 'live', approvals: data.data || [] };
}

/* ─── Users / Team ─── */

export async function listUsers(filters = {}) {
  const params = new URLSearchParams();
  params.set('$$LIMIT', String(filters.limit || 50));
  params.set('isActive', 'true');
  params.set('fields', 'name,emailAddr,title,roleID,role:name');

  const resp = await wfFetch(`/user/search?${params}`);
  if (!resp?.ok) return null;
  const data = await resp.json();
  return { source: 'live', users: data.data || [] };
}

/* ─── WOA Agent Simulations (kept as demo fallback) ─── */

const AGENTS = {
  aiReviewer: { name: 'AI Reviewer', status: 'open-beta', icon: '🔍' },
  aiFormFill: { name: 'AI Form Fill', status: 'open-beta', icon: '📝' },
  projectHealth: { name: 'Project Health', status: 'open-beta', icon: '📊' },
  intelligentAnswers: { name: 'Intelligent Answers', status: 'ga-planned', icon: '💬' },
};

export function getAgents() { return AGENTS; }
export function getAgentStatus() {
  return Object.entries(AGENTS).map(([key, agent]) => ({ key, ...agent }));
}

export async function reviewAsset(assetInfo) {
  return {
    agent: 'AI Reviewer', asset: assetInfo.name, status: 'reviewed', brandScore: 92,
    checks: [
      { rule: 'Logo placement', status: 'pass', detail: 'Primary logo in correct position per brand guide' },
      { rule: 'Color palette', status: 'pass', detail: 'All colors within approved brand palette' },
      { rule: 'Typography', status: 'warn', detail: 'Body text uses system font instead of Adobe Clean' },
      { rule: 'Image quality', status: 'pass', detail: 'Resolution meets minimum 2x requirement' },
      { rule: 'Tone of voice', status: 'pass', detail: 'Copy aligns with brand voice guidelines' },
    ],
    recommendation: 'Minor typography fix needed. Asset is 92% brand-compliant.',
  };
}

export async function fillForm(context) {
  return {
    agent: 'AI Form Fill', formType: context.formType || 'Project Brief',
    fieldsPopulated: 12, fieldsTotal: 15, confidence: 0.89,
    fields: [
      { name: 'Project Name', value: context.projectName || 'Mediterranean Campaign Q3', confidence: 0.95 },
      { name: 'Business Unit', value: 'Marketing', confidence: 0.92 },
      { name: 'Priority', value: 'High', confidence: 0.88 },
      { name: 'Target Launch', value: '2025-06-15', confidence: 0.85 },
      { name: 'Budget Category', value: 'Digital Campaign', confidence: 0.90 },
      { name: 'Approval Chain', value: 'Marketing Lead → Legal → Brand', confidence: 0.82 },
    ],
    needsReview: ['Budget Amount', 'Stakeholder List', 'Legal Requirements'],
  };
}

export async function getProjectHealth(projectId) {
  // Try real data first
  if (wfAuthMode !== 'demo') {
    const project = await getProject(projectId);
    if (project?.project) {
      const p = project.project;
      const tasks = p.tasks || [];
      const completed = tasks.filter((t) => t.status === 'CPL').length;
      const blocked = tasks.filter((t) => t.status === 'INP' && t.percentComplete === 0).length;
      return {
        agent: 'Project Health', source: 'live',
        projectId: p.ID, projectName: p.name,
        healthScore: p.percentComplete || 0,
        status: p.condition || p.status,
        tasks: { total: tasks.length, completed, inProgress: tasks.length - completed - blocked, blocked },
        timeline: { planned: p.plannedCompletionDate },
      };
    }
  }
  // Demo fallback
  return {
    agent: 'Project Health', source: 'demo', projectId: projectId || 'PRJ-2847',
    projectName: 'AEM XSC Showcase Launch', healthScore: 78, status: 'at-risk',
    insights: [
      { type: 'risk', message: 'Content review phase is 3 days behind schedule', impact: 'high' },
      { type: 'positive', message: 'Design assets delivered ahead of schedule', impact: 'medium' },
      { type: 'risk', message: '2 of 5 stakeholder approvals still pending', impact: 'high' },
      { type: 'positive', message: 'Budget utilization at 67% — on track', impact: 'low' },
    ],
    tasks: { total: 24, completed: 16, inProgress: 5, blocked: 3 },
  };
}

export async function askWorkfront(question) {
  // Try real data for common queries
  if (wfAuthMode !== 'demo') {
    const q = question.toLowerCase();
    if (q.includes('overdue') || q.includes('late')) {
      const result = await listTasks({ status: 'INP' });
      if (result.source === 'live') {
        const overdue = result.tasks.filter((t) => t.plannedCompletionDate && new Date(t.plannedCompletionDate) < new Date());
        return {
          agent: 'Intelligent Answers', source: 'live', question,
          answer: `**${overdue.length} overdue tasks found:**\n\n${overdue.map((t) => `- **${t.name}** (due ${t.plannedCompletionDate}, assigned to ${t['assignedTo:name'] || 'unassigned'})`).join('\n')}`,
        };
      }
    }
    if (q.includes('approval') || q.includes('pending')) {
      const result = await listApprovals({ status: 'PENDING' });
      if (result.source === 'live') {
        return {
          agent: 'Intelligent Answers', source: 'live', question,
          answer: `**${result.approvals.length} pending approvals:**\n\n${result.approvals.map((a) => `- **${a['approvalObj:name'] || 'Unnamed'}** — Waiting on ${a['approver:name'] || 'reviewer'}`).join('\n')}`,
        };
      }
    }
  }
  // Demo fallback
  return {
    agent: 'Intelligent Answers', source: 'demo', question,
    answer: generateAnswer(question),
    sources: ['Workfront Projects', 'Workfront Tasks', 'Workfront Approvals'],
  };
}

/* ─── Helpers ─── */

function priorityToNum(p) {
  const map = { none: 0, low: 1, normal: 2, high: 3, urgent: 4 };
  return map[(p || 'normal').toLowerCase()] ?? 2;
}

function generateAnswer(question) {
  const q = question.toLowerCase();
  if (q.includes('overdue') || q.includes('late') || q.includes('behind')) {
    return '**3 tasks are currently overdue:**\n\n1. **Content Review — Mediterranean Hero** (2 days late, assigned to @sarah)\n2. **Legal Disclaimer Update** (1 day late, assigned to @legal-team)\n3. **SEO Meta Optimization** (3 days late, unassigned)\n\nRecommendation: Escalate items 1 and 3 to project lead for reassignment.';
  }
  if (q.includes('approval') || q.includes('pending') || q.includes('waiting')) {
    return '**5 approvals pending across your projects:**\n\n- **Mediterranean Campaign Brief** — Waiting on Marketing VP (submitted 2 days ago)\n- **Q3 Budget Allocation** — Waiting on Finance (submitted 4 days ago)\n- **Brand Asset Package** — Waiting on Brand Team (submitted 1 day ago)\n- **Legal Review: Pricing Page** — In review (SLA: 48h remaining)\n- **Accessibility Audit Report** — Waiting on Engineering Lead\n\n2 approvals are approaching SLA deadline.';
  }
  if (q.includes('capacity') || q.includes('bandwidth') || q.includes('workload')) {
    return '**Team Capacity This Sprint:**\n\n| Team Member | Allocated | Available |\n|---|---|---|\n| Sarah Chen | 95% | 2h |\n| Mike Torres | 78% | 8h |\n| Lisa Park | 110% | -4h (over) |\n| James Wu | 65% | 14h |\n\nLisa Park is over-allocated. Consider redistributing 2 tasks to James Wu.';
  }
  return `I searched across your Workfront projects, tasks, and approvals. Based on current data:\n\n- **Active projects**: 8 (6 on track, 2 at risk)\n- **Your pending tasks**: 4 (2 due this week)\n- **Team velocity**: 94% of planned story points delivered last sprint\n\nWould you like me to dig deeper into any of these areas?`;
}

/* ─── Demo Fallback Data ─── */

function demoProjects() {
  return {
    source: 'demo',
    projects: [
      { ID: 'PRJ-2847', name: 'AEM XSC Showcase Launch', status: 'CUR', percentComplete: 67, priority: 3, condition: 'AR' },
      { ID: 'PRJ-3012', name: 'Mediterranean Campaign Q3', status: 'CUR', percentComplete: 42, priority: 2, condition: 'OT' },
      { ID: 'PRJ-2901', name: 'Brand Refresh 2026', status: 'PLN', percentComplete: 15, priority: 3, condition: 'OT' },
    ],
  };
}

function demoTasks() {
  return {
    source: 'demo',
    tasks: [
      { ID: 'TSK-4401', name: 'Content Review — Mediterranean Hero', status: 'INP', percentComplete: 60, priority: 3 },
      { ID: 'TSK-4402', name: 'Legal Disclaimer Update', status: 'INP', percentComplete: 0, priority: 4 },
      { ID: 'TSK-4403', name: 'SEO Meta Optimization', status: 'INP', percentComplete: 20, priority: 2 },
    ],
  };
}

function demoApprovals() {
  return {
    source: 'demo',
    approvals: [
      { ID: 'APR-001', 'approvalObj:name': 'Mediterranean Campaign Brief', status: 'PENDING', 'approver:name': 'Marketing VP' },
      { ID: 'APR-002', 'approvalObj:name': 'Q3 Budget Allocation', status: 'PENDING', 'approver:name': 'Finance Director' },
    ],
  };
}

/* ─── Webhook (N8N bridge) ─── */
const WF_WEBHOOK_KEY = 'ew-workfront-webhook';

export function getWebhookUrl() { return localStorage.getItem(WF_WEBHOOK_KEY) || ''; }
export function setWebhookUrl(url) {
  if (url) localStorage.setItem(WF_WEBHOOK_KEY, url.trim());
  else localStorage.removeItem(WF_WEBHOOK_KEY);
}
export function hasWebhook() { return !!getWebhookUrl(); }

export async function createTaskViaWebhook(payload) {
  const url = getWebhookUrl();
  if (!url) throw new Error('Workfront webhook URL not configured');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create_task', ...payload, timestamp: new Date().toISOString() }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Workfront webhook error ${resp.status}: ${errText.slice(0, 300)}`);
  }
  return resp.json().catch(() => ({ ok: true }));
}

/* ─── Route for Review (governance integration) ─── */
export async function routeForReview({ pagePath, issueType, severity, description }) {
  const task = await createTask({
    name: `${issueType}: ${pagePath}`,
    assignee: severity === 'critical' ? '@legal-review' : '@content-review',
    priority: severity === 'critical' ? 'Urgent' : 'High',
    description,
  });
  return {
    agent: 'Workfront', action: 'routed', task,
    sla: severity === 'critical' ? '24h' : '48h',
    message: `Task ${task.id || task.ID} created and assigned with ${severity === 'critical' ? '24h' : '48h'} SLA`,
  };
}
