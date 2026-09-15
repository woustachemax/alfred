require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// One or more base folders to scan, comma-separated — e.g. your code folder and
// Priyanka's. Every immediate subfolder with a .git in it, in any of them, becomes
// a usable repo under its own folder name. No repo has to physically live in any
// one person's directory for anyone else to reach it.
const CODE_DIRS = (process.env.CODE_DIRS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
// repos.json is now optional and only for exceptions: mark an auto-discovered repo
// ownerOnly, exclude one you don't want reachable, or add a path outside CODE_DIRS.
const REPOS_CONFIG_PATH = process.env.REPOS_CONFIG_PATH || path.join(__dirname, 'repos.json');
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
// Telegram user IDs of everyone with owner-level trust — you, and anyone else you
// trust the same way (e.g. a co-owner). All still run through this one Claude Code
// login on the server; owner status is a permissions label, not a separate account.
// Gates ownerOnly repos to this list, and is where the bot sends a quiet copy of
// every non-owner-triggered result. In a private DM with the bot, chat ID == user ID.
const OWNER_IDS = (process.env.OWNER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const MAX_TURNS = process.env.MAX_TURNS || '40';
const MAX_BUDGET_USD = process.env.MAX_BUDGET_USD || '3.00';
const GITHUB_REMOTE = process.env.GITHUB_REMOTE || 'origin';
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';

if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

function discoverRepos() {
  const found = {};
  for (const dir of CODE_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`Couldn't scan CODE_DIRS entry (${dir}):`, err.message);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (!fs.existsSync(path.join(full, '.git'))) continue;
      if (found[entry.name]) {
        console.error(`Repo name "${entry.name}" exists in more than one CODE_DIRS folder — keeping ${found[entry.name].path}, ignoring ${full}`);
        continue;
      }
      found[entry.name] = { path: full, ownerOnly: false };
    }
  }
  return found;
}

function loadRepos() {
  const merged = discoverRepos();

  let overrides = {};
  try {
    overrides = JSON.parse(fs.readFileSync(REPOS_CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Couldn't read ${REPOS_CONFIG_PATH}:`, err.message);
    // missing repos.json is fine — CODE_DIR discovery alone can carry the whole thing
  }

  for (const [name, val] of Object.entries(overrides)) {
    if (name.startsWith('_')) continue; // lets repos.json carry "_comment"-style notes, JSON has no real comments
    if (val === false || (val && val.exclude)) {
      delete merged[name];
      continue;
    }
    const normalized = typeof val === 'string' ? { path: val } : val;
    merged[name] = { ...merged[name], ...normalized };
  }

  return merged;
}

const bot = new TelegramBot(TOKEN, { polling: true });

// One job at a time, whoever asked and whichever repo — simplest way to guarantee
// two teammates never collide on the same git working copy.
let busy = false;
const queue = [];

function enqueue(job) {
  queue.push(job);
  processQueue();
}

async function processQueue() {
  if (busy || queue.length === 0) return;
  busy = true;
  const job = queue.shift();
  try {
    await job();
  } catch (err) {
    console.error('Job failed:', err);
  } finally {
    busy = false;
    processQueue();
  }
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr || stdout}`));
    });
    proc.on('error', reject);
  });
}

function isAllowed(chatId) {
  if (ALLOWED_CHAT_IDS.length === 0) return true; // open by default if unset — lock this down before real use
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

function displayName(from) {
  if (!from) return 'someone';
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || `user ${from.id}`;
}

function isOwner(from) {
  return from && OWNER_IDS.includes(String(from.id));
}

function branchNameFor(issueText) {
  const slug =
    issueText
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'issue';
  return `claude/${slug}-${Date.now()}`;
}

async function handleFixRequest(chatId, requester, repoName, issueText) {
  const repos = loadRepos();
  const repo = repos[repoName];

  if (!repo) {
    const known = Object.keys(repos).join(', ') || '(none configured)';
    await bot.sendMessage(chatId, `Don't know a repo called "${repoName}". Known repos: ${known}`);
    return;
  }

  if (repo.ownerOnly && !isOwner(requester)) {
    await bot.sendMessage(chatId, `"${repoName}" is owner-only.`);
    return;
  }

  const repoPath = repo.path;
  const who = displayName(requester);

  await bot.sendMessage(chatId, `[${repoName}] ${who} asked for:\n"${issueText}"\nWorking on it.`);

  const branch = branchNameFor(issueText);

  try {
    await run('git', ['fetch', GITHUB_REMOTE], repoPath);
    await run('git', ['checkout', BASE_BRANCH], repoPath);
    await run('git', ['pull', GITHUB_REMOTE, BASE_BRANCH], repoPath);
    await run('git', ['checkout', '-b', branch], repoPath);
  } catch (err) {
    await bot.sendMessage(chatId, `[${repoName}] Couldn't prep a branch: ${err.message}`);
    return;
  }

  const prompt = [
    issueText,
    '',
    'Work until this is actually fixed, not just attempted once. If the repo has tests, ' +
      'a build, or a lint step, run them after your change and treat a failure as unfinished ' +
      'work: read the failure, fix it, and rerun. Keep repeating that cycle on your own until ' +
      'it passes or you are certain the task is complete. Do not stop to ask questions.',
    '',
    'When you are done, stage and commit your changes with a clear message.',
    'Do not push and do not open a pull request — that happens outside this session.'
  ].join('\n');

  let rawOutput;
  try {
    // No --bare: bare mode never reads OAuth/subscription login, only ANTHROPIC_API_KEY.
    // Log into `claude` once, interactively, on this server so every run — no matter who
    // triggered it from Telegram — bills to your subscription, not a per-token API key.
    const { stdout } = await run('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--allowedTools', 'Read,Edit,Bash,Write',
      '--permission-mode', 'acceptEdits',
      '--permission-prompts', 'none',
      '--max-turns', String(MAX_TURNS),
      '--max-budget-usd', String(MAX_BUDGET_USD),
      '--add-dir', repoPath
    ], repoPath);
    rawOutput = stdout;
  } catch (err) {
    await bot.sendMessage(chatId, `[${repoName}] Claude run failed: ${err.message}`);
    await run('git', ['checkout', BASE_BRANCH], repoPath).catch(() => {});
    return;
  }

  let summary = 'Done — see the diff.';
  try {
    const parsed = JSON.parse(rawOutput);
    summary = parsed.result || summary;
    if (typeof parsed.total_cost_usd === 'number') {
      summary += `\n\n(cost: $${parsed.total_cost_usd.toFixed(2)})`;
    }
  } catch {
    summary = rawOutput.slice(0, 800);
  }

  let hasChanges = false;
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], repoPath);
    hasChanges = stdout.trim().length > 0;
  } catch {}

  if (hasChanges) {
    try {
      await run('git', ['add', '-A'], repoPath);
      await run('git', ['commit', '-m', `claude: ${issueText} (requested by ${who})`.slice(0, 100)], repoPath);
    } catch (err) {
      if (!/nothing to commit/i.test(err.message)) {
        await bot.sendMessage(chatId, `[${repoName}] Commit step warning: ${err.message}`);
      }
    }
  }

  try {
    await run('git', ['push', '-u', GITHUB_REMOTE, branch], repoPath);
  } catch (err) {
    await bot.sendMessage(chatId, `[${repoName}] Push failed: ${err.message}`);
    await run('git', ['checkout', BASE_BRANCH], repoPath).catch(() => {});
    return;
  }

  let prUrl = null;
  try {
    const { stdout } = await run('gh', [
      'pr', 'create',
      '--title', issueText.slice(0, 72),
      '--body', `Requested by ${who} via Telegram.\n\n${summary}`,
      '--base', BASE_BRANCH,
      '--head', branch
    ], repoPath);
    const match = stdout.match(/https:\/\/\S+/);
    prUrl = match ? match[0] : null;
  } catch (err) {
    await bot.sendMessage(chatId, `[${repoName}] Branch pushed as ${branch}, but PR creation failed: ${err.message}`);
    await run('git', ['checkout', BASE_BRANCH], repoPath).catch(() => {});
    return;
  }

  await run('git', ['checkout', BASE_BRANCH], repoPath).catch(() => {});

  const finalMessage = `[${repoName}] Done — asked by ${who}.\n${summary}\n\n${prUrl ? `PR: ${prUrl}` : `Branch: ${branch}`}`;
  await bot.sendMessage(chatId, finalMessage);

  // Quiet copy to every other owner if someone (owner or not) triggered this from a
  // shared/team chat — so you and Priyanka both stay across everything without
  // watching the group live.
  for (const ownerId of OWNER_IDS) {
    if (String(ownerId) === String(requester.id)) continue; // don't echo it back to whoever just asked
    if (String(chatId) === String(ownerId)) continue; // already the chat that got the message
    await bot.sendMessage(ownerId, finalMessage).catch(() => {});
  }
}

// /fix <repo> <description>
bot.onText(/^\/fix (\S+) (.+)/s, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) {
    bot.sendMessage(chatId, "This chat isn't authorized to trigger code changes.");
    return;
  }
  enqueue(() => handleFixRequest(chatId, msg.from, match[1].trim(), match[2].trim()));
});

bot.onText(/^\/repos$/, msg => {
  const repos = loadRepos();
  const isReqOwner = isOwner(msg.from);
  const visible = Object.entries(repos)
    .filter(([, r]) => !r.ownerOnly || isReqOwner)
    .map(([name, r]) => `- ${name}${r.ownerOnly ? ' (owner-only)' : ''}`);
  bot.sendMessage(
    msg.chat.id,
    visible.length ? `Known repos:\n${visible.join('\n')}` : 'No repos configured yet — edit repos.json.'
  );
});

bot.onText(/^\/start$/, msg => {
  bot.sendMessage(
    msg.chat.id,
    "Send /fix <repo> <description> and I'll work on it in a new branch and open a PR.\nSend /repos to see which repos I know about."
  );
});

console.log('Bot running. Waiting for /fix commands...');
