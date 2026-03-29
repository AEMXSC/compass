/*
 * Workfront Workflow Optimization Agent (WOA) Client
 * Models the four P1 skills from the Workfront AI roadmap:
 *   1. AI Reviewer — brand guideline compliance for assets
 *   2. AI Form Fill — AI-powered form completion from prompts/docs
 *   3. Project Health — AI assessment of project/program performance
 *   4. Intelligent Answers — NL questions across Workfront ecosystem
 *
 * Currently runs in demo mode with simulated responses.
 * Wire to real Workfront API when endpoints are available.
 */

import { fetchWithToken, getToken } from './ims.js';

const WF_BASE = 'https://aemxsc.my.workfront.com';

/* ── Agent Status ── */
const AGENTS = {
  aiReviewer: {
    name: 'AI Reviewer',
    status: 'open-beta',
    ga: 'Q1 FY26',
    description: 'Checks assets against brand guidelines and provides feedback',
    icon: '🔍',
  },
  aiFormFill: {
    name: 'AI Form Fill',
    status: 'open-beta',
    ga: '12/3/25',
    description: 'AI-powered form completion from prompts or documents',
    icon: '📝',
  },
  projectHealth: {
    name: 'Project Health',
    status: 'open-beta',
    ga: 'TBD',
    description: 'AI assessment analyzing project and program performance',
    icon: '📊',
  },
  intelligentAnswers: {
    name: 'Intelligent Answers',
    status: 'ga-planned',
    ga: '12/3/25',
    description: 'Natural language questions across Workfront ecosystem',
    icon: '💬',
  },
};

export function getAgents() {
  return AGENTS;
}

export function getAgentStatus() {
  return Object.entries(AGENTS).map(([key, agent]) => ({
    key,
    ...agent,
  }));
}

/* ── AI Reviewer (Brand Compliance) ── */
export async function reviewAsset(assetInfo) {
  // In production: POST to Workfront WOA AI Reviewer endpoint
  // For now: return simulated review aligned with real feature capabilities
  const { name, type, url } = assetInfo;

  return {
    agent: 'AI Reviewer',
    asset: name,
    status: 'reviewed',
    brandScore: 92,
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

/* ── AI Form Fill ── */
export async function fillForm(context) {
  // In production: POST to Workfront WOA AI Form Fill endpoint
  const { formType, briefText, projectName } = context;

  return {
    agent: 'AI Form Fill',
    formType: formType || 'Project Brief',
    fieldsPopulated: 12,
    fieldsTotal: 15,
    confidence: 0.89,
    fields: [
      { name: 'Project Name', value: projectName || 'Mediterranean Campaign Q3', confidence: 0.95 },
      { name: 'Business Unit', value: 'Marketing', confidence: 0.92 },
      { name: 'Priority', value: 'High', confidence: 0.88 },
      { name: 'Target Launch', value: '2025-06-15', confidence: 0.85 },
      { name: 'Budget Category', value: 'Digital Campaign', confidence: 0.90 },
      { name: 'Approval Chain', value: 'Marketing Lead → Legal → Brand', confidence: 0.82 },
    ],
    needsReview: ['Budget Amount', 'Stakeholder List', 'Legal Requirements'],
  };
}

/* ── Project Health ── */
export async function getProjectHealth(projectId) {
  // In production: GET from Workfront WOA Project Health endpoint
  return {
    agent: 'Project Health',
    projectId: projectId || 'PRJ-2847',
    projectName: 'AEM XSC Showcase Launch',
    healthScore: 78,
    status: 'at-risk',
    insights: [
      { type: 'risk', message: 'Content review phase is 3 days behind schedule', impact: 'high' },
      { type: 'positive', message: 'Design assets delivered ahead of schedule', impact: 'medium' },
      { type: 'risk', message: '2 of 5 stakeholder approvals still pending', impact: 'high' },
      { type: 'positive', message: 'Budget utilization at 67% — on track', impact: 'low' },
      { type: 'suggestion', message: 'Consider parallel review tracks to recover 2 days', impact: 'medium' },
    ],
    timeline: {
      planned: '2025-06-15',
      projected: '2025-06-18',
      variance: '+3 days',
    },
    tasks: { total: 24, completed: 16, inProgress: 5, blocked: 3 },
  };
}

/* ── Intelligent Answers ── */
export async function askWorkfront(question) {
  // In production: POST to Workfront WOA Intelligent Answers endpoint
  // Understands context across projects, tasks, approvals, timesheets, etc.
  return {
    agent: 'Intelligent Answers',
    question,
    answer: generateAnswer(question),
    sources: ['Workfront Projects', 'Workfront Tasks', 'Workfront Approvals'],
    confidence: 0.87,
  };
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

/* ── Webhook Config ── */
const WF_WEBHOOK_KEY = 'ew-workfront-webhook';

export function getWebhookUrl() {
  return localStorage.getItem(WF_WEBHOOK_KEY) || '';
}

export function setWebhookUrl(url) {
  if (url) {
    localStorage.setItem(WF_WEBHOOK_KEY, url.trim());
  } else {
    localStorage.removeItem(WF_WEBHOOK_KEY);
  }
}

export function hasWebhook() {
  return !!getWebhookUrl();
}

/**
 * Create a Workfront task via webhook (N8N, Zapier, etc.).
 * POSTs the task payload; expects JSON response with at least { id, status }.
 */
export async function createTaskViaWebhook(payload) {
  const url = getWebhookUrl();
  if (!url) throw new Error('Workfront webhook URL not configured');

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create_task',
      ...payload,
      timestamp: new Date().toISOString(),
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Workfront webhook error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  return resp.json();
}

/* ── Create Task (used by governance fix routing) ── */
export async function createTask({ projectId, name, assignee, priority, description }) {
  // If webhook is configured, use it
  if (hasWebhook()) {
    return createTaskViaWebhook({ projectId, name, assignee, priority, description });
  }

  // Fallback: simulated response
  return {
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

/* ── Route for Review (governance integration) ── */
export async function routeForReview({ pagePath, issueType, severity, description }) {
  const task = await createTask({
    name: `${issueType}: ${pagePath}`,
    assignee: severity === 'critical' ? '@legal-review' : '@content-review',
    priority: severity === 'critical' ? 'Urgent' : 'High',
    description,
  });

  return {
    agent: 'Workfront',
    action: 'routed',
    task,
    sla: severity === 'critical' ? '24h' : '48h',
    message: `Task ${task.id} created and assigned to ${task.assignee} with ${severity === 'critical' ? '24h' : '48h'} SLA`,
  };
}
