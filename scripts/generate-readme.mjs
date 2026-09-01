#!/usr/bin/env node
/**
 * GitHub Profile README 自动生成器
 * ------------------------------------------------------------
 * - 从 GitHub API 读取：用户统计 / 置顶仓库 / 公开仓库 / 最近动态
 * - 把结果写回 README.md 里对应的 AUTO 标记区块（其余内容不动）
 * - 零依赖，Node.js >= 18（使用内置 fetch）
 * - 由 .github/workflows/update-readme.yml 定时触发，也可本地运行：
 *     GITHUB_TOKEN=xxx node scripts/generate-readme.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* ========================= 配置 ========================= */
const USER = process.env.GH_USER || 'a1175815821';
const README_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md');
const TOP_REPOS = 8;   // 「更多仓库」表格行数
const TOP_EVENTS = 8;  // 「最近动态」条数
const MAX_DESC = 50;   // 仓库说明截断长度

/* ========================= API ========================= */
const TOKEN = process.env.GITHUB_TOKEN; // workflow 自动注入；本地可不填（有 60 次/小时限额）
const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'profile-readme-generator',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}：GET ${path}`);
  return res.json();
}

/** 通过 GraphQL 读取个人资料的「置顶仓库」，与 GitHub 主页 Pinned 保持一致 */
async function fetchPinned() {
  const query = `query($login: String!) {
    user(login: $login) {
      pinnedItems(first: 6, types: REPOSITORY) {
        nodes { ... on Repository {
          name
          description
          url
          fork
          stargazerCount
          primaryLanguage { name }
        } }
      }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`GraphQL：${data.errors[0]?.message ?? '未知错误'}`);
  return data.data?.user?.pinnedItems?.nodes ?? [];
}

/* ======================= 工具函数 ======================= */
/** 压平空白、转义 HTML 字符与竖线，避免破坏 Markdown / 表格 */
const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .trim();

/** 截断超长文本（先截断后转义，避免把 HTML 实体切成两半） */
const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 相对时间（中文） */
function ago(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const table = [[31536000, '年'], [2592000, '个月'], [86400, '天'], [3600, '小时'], [60, '分钟']];
  for (const [s, label] of table) if (sec >= s) return `${Math.floor(sec / s)} ${label}前`;
  return '刚刚';
}

/** 用生成内容替换 README 中一对 AUTO 标记之间的部分 */
function replace(md, name, body) {
  const start = `<!-- AUTO:START:${name} -->`;
  const end = `<!-- AUTO:END:${name} -->`;
  const i = md.indexOf(start);
  const j = md.indexOf(end);
  if (i === -1 || j === -1) throw new Error(`README.md 中找不到标记：${start}`);
  // 内容前后留空行，确保表格 / 标题等 Markdown 块级元素紧跟注释行时也能正常解析
  return `${md.slice(0, i + start.length)}\n\n${body}\n\n${md.slice(j)}`;
}

/* ======================= 区块渲染 ======================= */
function renderBadges(user, repos) {
  if (!user) return '<!-- 本次数据获取失败，等待下次运行自动恢复 -->';
  const stars = repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  const forks = repos.reduce((s, r) => s + (r.forks_count || 0), 0);
  const badge = (label, val, color, logo) =>
    `<img src="https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(val)}-${color}?style=flat-square&logo=${logo}" alt="${label}">`;
  return [
    badge('公开仓库', user.public_repos ?? 0, 'blue', 'github'),
    badge('获得 Stars', stars, 'yellow', 'githubsponsors'),
    badge('Forks', forks, 'orange', 'git'),
    badge('关注者', user.followers ?? 0, '7C3AED', 'github'),
    badge('入驻年份', new Date(user.created_at).getFullYear() || '—', '06B6D4', 'github'),
  ].join(' ');
}

function renderPinned(items) {
  if (!items.length) return '<!-- 暂无置顶仓库：去 GitHub 主页设置 Pinned repositories 后自动出现 -->';
  return items
    .map((r) => {
      const meta = [
        r.primaryLanguage?.name ? `\`${r.primaryLanguage.name}\`` : '',
        `⭐ ${r.stargazerCount ?? 0}`,
        r.fork ? '🍴 Fork' : '',
      ].filter(Boolean).join(' · ');
      return [
        `### ${r.fork ? '🍴' : '📦'} [${r.name}](${r.url})`,
        '',
        r.description ? clean(clip(r.description, 80)) : '*(暂无描述)*',
        '',
        meta,
      ].join('\n');
    })
    .join('\n\n---\n\n');
}

function renderRepos(repos) {
  if (!repos.length) return '<!-- 暂无仓库 -->';
  const rows = repos.map((r) => {
    const name = `${r.fork ? '🍴 ' : ''}[${r.name}](${r.html_url})`;
    return `| ${name} | ${clean(clip(r.description, MAX_DESC)) || '—'} | ${r.language || '—'} | ${r.stargazers_count > 0 ? `⭐ ${r.stargazers_count}` : '—'} |`;
  });
  return ['| 仓库 | 说明 | 语言 | Stars |', '|:---|:---|:---:|:---:|', ...rows].join('\n');
}

/** 把一条公开事件翻译成中文描述，不认识的事件返回 null */
function eventText(ev) {
  const repoName = ev.repo?.name ?? '';
  const repo = `[${repoName.replace(`${USER}/`, '')}](https://github.com/${repoName})`;
  switch (ev.type) {
    case 'PushEvent': {
      const n = ev.payload?.size || ev.payload?.commits?.length || 0;
      // size=0 常见于分支删除等特殊推送，避免显示「0 个提交」
      return n > 0 ? `⬆️ 推送了 **${n} 个提交**到 ${repo}` : `⬆️ 向 ${repo} 推送了新代码`;
    }
    case 'PullRequestEvent': {
      const pr = ev.payload?.pull_request;
      if (!pr) return null;
      const verb = { opened: '开启了', closed: '关闭了', reopened: '重新开启' }[ev.payload.action] || '更新了';
      return `🔀 ${verb} PR [#${pr.number}](${pr.html_url}) · ${repo}`;
    }
    case 'IssuesEvent': {
      const issue = ev.payload?.issue;
      if (!issue) return null;
      const verb = { opened: '提了', closed: '关闭了', reopened: '重新打开' }[ev.payload.action] || '更新了';
      return `🐛 ${verb} Issue [#${issue.number}](${issue.html_url}) · ${repo}`;
    }
    case 'IssueCommentEvent': {
      const issue = ev.payload?.issue;
      if (!issue) return null;
      return `💬 在 ${repo} 的 [#${issue.number}](${issue.html_url}) 中评论`;
    }
    case 'PullRequestReviewEvent':
      return `👀 审查了 ${repo} 的 PR`;
    case 'CreateEvent': {
      const type = { branch: '分支', tag: '标签', repository: '仓库' }[ev.payload?.ref_type] || '内容';
      return `🌱 在 ${repo} 创建了${type}`;
    }
    case 'ReleaseEvent': {
      const rel = ev.payload?.release;
      if (!rel) return null;
      return `🚀 在 ${repo} 发布了 [${clean(clip(rel.name || rel.tag_name, 30))}](${rel.html_url})`;
    }
    case 'ForkEvent': {
      const fk = ev.payload?.forkee;
      return fk ? `🍴 Fork 了 [${fk.full_name}](${fk.html_url})` : null;
    }
    case 'WatchEvent':
      return `⭐ Star 了 ${repo}`;
    default:
      return null;
  }
}

function renderActivity(events) {
  const seen = new Set(); // 同一仓库同类事件只保留最新一条
  const lines = [];
  for (const ev of events) {
    if (lines.length >= TOP_EVENTS) break;
    const text = eventText(ev);
    if (!text) continue;
    const key = `${ev.type}:${ev.repo?.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${text} <sub>\`${ago(ev.created_at)}\`</sub>`);
  }
  return lines.length ? lines.join('\n') : '<!-- 最近没有公开动态 -->';
}

/* ========================= 主流程 ======================== */
async function main() {
  // 四路数据并行获取，单路失败不影响其它区块
  const [user, repos, events, pinned] = await Promise.allSettled([
    api(`/users/${USER}`),
    api(`/users/${USER}/repos?per_page=100&sort=pushed&type=owner`),
    api(`/users/${USER}/events/public?per_page=30`),
    fetchPinned(),
  ]);
  const pick = (r, fallback, label) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`⚠️ ${label} 获取失败：${r.reason?.message ?? r.reason}（该区块保持原样）`);
    return fallback;
  };

  const profile = pick(user, null, '用户统计');
  const repoList = pick(repos, [], '仓库列表');
  const eventList = pick(events, [], '最近动态');
  const pinnedList = pick(pinned, [], '置顶仓库');

  // 过滤掉 Profile 仓库本身，按 Stars → 最近活跃排序
  const own = repoList
    .filter((r) => r.name?.toLowerCase() !== USER.toLowerCase())
    .sort(
      (a, b) =>
        b.stargazers_count - a.stargazers_count ||
        new Date(b.pushed_at) - new Date(a.pushed_at),
    );

  // 没设置置顶仓库时，回退展示 Stars 最多的 2 个原创仓库
  // （REST 字段映射成与 GraphQL 置顶数据一致的形状，renderPinned 才能统一处理）
  const featured = pinnedList.length
    ? pinnedList
    : own
        .filter((r) => !r.fork)
        .slice(0, 2)
        .map((r) => ({
          name: r.name,
          description: r.description,
          url: r.html_url,
          fork: r.fork,
          stargazerCount: r.stargazers_count ?? 0,
          primaryLanguage: r.language ? { name: r.language } : null,
        }));

  let md = await readFile(README_PATH, 'utf8');
  md = replace(md, 'badges', renderBadges(profile, own));
  md = replace(md, 'pinned', renderPinned(featured));
  md = replace(md, 'repos', renderRepos(own.slice(0, TOP_REPOS)));
  md = replace(md, 'activity', renderActivity(eventList));
  await writeFile(README_PATH, md, 'utf8');
  console.log('✅ README.md 自动区块已更新');
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
