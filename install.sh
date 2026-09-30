#!/bin/sh
# openMeet installer.
#
#   curl -fsSL https://raw.githubusercontent.com/pranshhu/openMeet/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/pranshhu/openMeet/main/install.sh | sh -s -- --local
#
# Clones the repo, installs everything it needs, logs you in to Cloudflare, and
# deploys your own instance. All you need is a Cloudflare account (free tier is
# enough), plus git and Node >= 20.11 on the machine.
#
# --local skips Cloudflare entirely and just sets up a checkout you can run on
# localhost.
#
# Deploying needs a terminal, because two steps are interactive by nature: the
# Cloudflare login opens a browser, and you get asked what to name the project.
# With no terminal (CI, a pipe with no tty) it falls back to --local rather than
# failing, since it could not have prompted you anyway.
#
# openMeet is not a binary, so nothing lands on your PATH. wrangler is not
# installed globally either -- it is a dependency of the repo, so `pnpm install`
# below is what provides it.
#
# Safe to re-run: every step reuses whatever it already created.
set -eu

REPO="${OPENMEET_REPO:-https://github.com/pranshhu/openMeet.git}"
DIR="${OPENMEET_DIR:-openMeet}"
DB_NAME="${OPENMEET_DB:-openmeet_db}"
PROJECT="${OPENMEET_PROJECT:-}"
MODE=deploy

# --- output -----------------------------------------------------------------
if [ -t 1 ]; then
  B='\033[1m'; DIM='\033[2m'; R='\033[31m'; G='\033[32m'; Y='\033[33m'; N='\033[0m'
else
  B=''; DIM=''; R=''; G=''; Y=''; N=''
fi
say()  { printf '%b\n' "$*"; }
step() { printf '%b\n' "${B}==>${N} $*"; }
warn() { printf '%b\n' "${Y}warning:${N} $*" >&2; }
die()  { printf '%b\n' "${R}error:${N} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
openMeet installer

  install.sh [--local] [--project NAME] [--dir PATH]

By default: clone, install, log in to Cloudflare, and deploy your own instance.
You need a Cloudflare account (free tier is fine), git, and Node >= 20.11.

  --local          Set up a checkout to run on localhost. No Cloudflare, no
                   account, nothing deployed.
  --project NAME   Pages project name; your instance is served at
                   https://NAME.pages.dev. Prompted for if omitted.
  --dir PATH       Where to clone (default: ./openMeet).
  -h, --help       This.

Environment: OPENMEET_REPO, OPENMEET_DIR, OPENMEET_DB, OPENMEET_PROJECT

  CLOUDFLARE_ACCOUNT_ID   If your Cloudflare login can see more than one
                          account, set this to the account to deploy to.
                          wrangler cannot ask which one here.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --local)   MODE=local ;;
    --deploy)  MODE=deploy ;;   # the default; accepted for explicitness
    --project) PROJECT="${2:-}"; shift ;;
    --dir)     DIR="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# Whether this process has a controlling terminal.
#
# NOT `[ -r /dev/tty ]`. That only checks file permissions, and /dev/tty is
# world-readable on Linux whether or not a terminal exists — so the test passes
# in CI, deploy mode is kept, and the login then dies on an ENXIO nobody can
# read. Opening it is the only honest check.
has_tty() { ( : < /dev/tty ) 2>/dev/null; }

# Deploying needs a terminal: the Cloudflare login opens a browser and the
# project name is a prompt. Piped into `sh` from a script or CI there is no tty,
# so fall back rather than fail on a question nobody can answer.
if [ "$MODE" = deploy ] && ! has_tty; then
  warn "No terminal available, so the Cloudflare login and project-name prompt
         cannot run. Setting up locally instead. To deploy, run install.sh
         from a terminal."
  MODE=local
fi

# Validate up front, before the clone, `pnpm install` and any network round-trip,
# so a typo costs nothing.
if [ -n "$PROJECT" ]; then
  case "$PROJECT" in
    *[!a-z0-9-]*) die "Project name must be lowercase letters, digits and hyphens: got '$PROJECT'" ;;
  esac
fi

have() { command -v "$1" >/dev/null 2>&1; }

# Every wrangler call goes through this. Two reasons it is not `npx wrangler`:
# npx resolves a DIFFERENT, unpinned wrangler from the root of a pnpm workspace
# (the real binary lives in apps/worker/node_modules/.bin), and wrangler only
# finds wrangler.toml when it runs with apps/worker as its cwd.
wr() { pnpm --filter @openmeet/worker exec wrangler "$@"; }

# Prompts must read the terminal directly. Piped into `sh`, stdin is the script
# itself, so a bare `read` consumes the rest of this file instead of the answer.
ask() {
  _prompt="$1"; _default="${2:-}"; _reply=""
  if has_tty; then
    printf '%b' "$_prompt" > /dev/tty
    IFS= read -r _reply < /dev/tty || _reply=""
  fi
  [ -n "$_reply" ] || _reply="$_default"
  printf '%s' "$_reply"
}

# --- prerequisites ----------------------------------------------------------
step "Checking prerequisites"

have git || die "git is required."
have node || die "Node.js >= 20.11 is required — https://nodejs.org"

node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a>20||(a===20&&b>=11))?0:1)' \
  || die "Node $(node -v) is too old — openMeet needs >= 20.11"
say "  node $(node -v)"

# Newer Node releases no longer bundle corepack, and `corepack enable` fails
# when it cannot write next to a root-owned node binary. Either way, say how to
# get pnpm.
if ! have pnpm && have corepack; then
  say "  pnpm missing — enabling via corepack"
  corepack enable pnpm >/dev/null 2>&1 || warn "corepack could not enable pnpm."
fi
have pnpm || die "pnpm is required. Install it with \`npm i -g pnpm@9\` (or see https://pnpm.io/installation), then re-run."
say "  pnpm $(pnpm --version)"

# --- checkout ---------------------------------------------------------------
in_repo() {
  [ -f package.json ] && node -e 'process.exit(require("./package.json").name==="openmeet"?0:1)' 2>/dev/null
}

if in_repo; then
  step "Already inside an openMeet checkout — using it"
elif [ -d "$DIR/.git" ]; then
  step "Reusing existing checkout at $DIR"
  cd "$DIR"
else
  step "Cloning openMeet into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
  cd "$DIR"
fi
ROOT=$(pwd)

step "Installing dependencies"
pnpm install --frozen-lockfile

# --- local mode -------------------------------------------------------------
if [ "$MODE" = local ]; then
  step "Preparing a local database"
  pnpm --filter @openmeet/worker db:migrate:local

  say ""
  say "${G}Ready.${N} openMeet is set up at ${B}${ROOT}${N}"
  say ""
  say "Run it — two terminals:"
  say "  ${DIM}# API + signalling${N}"
  say "  cd \"$ROOT\""
  say "  pnpm --filter @openmeet/worker dev"
  say "  ${DIM}# web app${N}"
  say "  cd \"$ROOT\""
  say "  pnpm --filter @openmeet/web dev"
  say ""
  say "Then open ${B}http://localhost:3000${N} in ${B}Chrome${N} (or another Chromium"
  say "browser) and click New Room. The host needs Chromium; Firefox can't"
  say "record, and a Safari guest is recorded as video only (no WAV)."
  say ""
  say "To deploy your own instance, from ${B}${ROOT}${N} run:  ${B}./install.sh${N}"
  exit 0
fi

# --- deploy mode ------------------------------------------------------------
step "Cloudflare login"
# By output, not exit code: `wrangler whoami` exits 0 when logged out too. It
# prints "You are logged in ..." for every kind of login (OAuth or API token)
# and "You are not authenticated" otherwise.
logged_in() { wr whoami 2>/dev/null | grep -q 'You are logged in'; }
if logged_in; then
  say "  already logged in"
else
  say "  Opening Cloudflare in your browser to authorise this machine."
  say "  ${DIM}If no browser opens, wrangler prints a URL — paste it into one.${N}"
  # < /dev/tty is load-bearing. Piped into `sh`, stdin is this script, so
  # wrangler would read the rest of the file as input instead of waiting.
  wr login < /dev/tty || die "Cloudflare login failed or was cancelled."
  logged_in || die "Login did not complete. Re-run when you are logged in."
  say "  logged in"
fi

if [ -z "$PROJECT" ]; then
  PROJECT=$(ask "Pages project name ${DIM}[openmeet]${N}: " "openmeet")
fi
case "$PROJECT" in
  *[!a-z0-9-]*|"") die "Project name must be lowercase letters, digits and hyphens: got '$PROJECT'" ;;
esac

# 1. D1 -----------------------------------------------------------------------
step "Setting up D1 database '$DB_NAME'"
DB_ID=$(wr d1 list --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=s.indexOf("[");const m=JSON.parse(s.slice(i<0?0:i)).find(d=>d.name===process.argv[1]);process.stdout.write(m?(m.uuid||m.database_id||""):"")}catch{process.stdout.write("")}})' "$DB_NAME" || true)

if [ -z "$DB_ID" ]; then
  wr d1 create "$DB_NAME" >/dev/null
  DB_ID=$(wr d1 list --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=s.indexOf("[");const m=JSON.parse(s.slice(i<0?0:i)).find(d=>d.name===process.argv[1]);process.stdout.write(m?(m.uuid||m.database_id||""):"")}catch{process.stdout.write("")}})' "$DB_NAME" || true)
  say "  created"
else
  say "  already exists — reusing"
fi
[ -n "$DB_ID" ] || die "Could not determine the database id for '$DB_NAME'. Create it manually with: pnpm --filter @openmeet/worker exec wrangler d1 create $DB_NAME"
say "  id $DB_ID"

# 2. Pages --------------------------------------------------------------------
step "Creating the Pages project '$PROJECT'"
# Only "already exists" is benign. Swallowing every other failure here sends the
# user through a minute of `pnpm build` before dying at `pages deploy` with an
# error about a project that was never created.
if _out=$(wr pages project create "$PROJECT" --production-branch main 2>&1); then
  say "  created"
else
  case "$_out" in
    *[Aa]lready*exists*) say "  already exists — reusing" ;;
    *) die "could not create the Pages project '$PROJECT':\n$_out" ;;
  esac
fi

# Cloudflare doesn't always hand back <project>.pages.dev -- a name collision
# across the account gets suffixed (e.g. openmeet-2ab.pages.dev) -- so read the
# domain it actually assigned instead of assuming. `pages project list` prints
# a table with a "Project Domains" column; grep the row for this project.
_dom=$(wr pages project list 2>/dev/null | grep -F " $PROJECT " | grep -oE '[a-z0-9-]+\.pages\.dev' | head -1)
if [ -n "$_dom" ]; then
  PAGES_ORIGIN="https://$_dom"
else
  PAGES_ORIGIN="https://${PROJECT}.pages.dev"
  warn "could not read the Pages project's actual domain; guessing $PAGES_ORIGIN. If the deployed site can't reach the Worker (CORS errors in the browser console), fix PAGES_ORIGIN in apps/worker/wrangler.toml and redeploy the Worker."
fi
say "  domain $PAGES_ORIGIN"

# 3. Config -------------------------------------------------------------------
# Both values ship as placeholders so a fresh clone doesn't deploy against
# someone else's account. Rewrite whatever is there — makes re-runs idempotent.
# Only the top level: everything from the first [env.*] header on (the
# maintainers' public demo) is passed through untouched.
step "Writing your values into apps/worker/wrangler.toml"
TOML="$ROOT/apps/worker/wrangler.toml"
[ -f "$TOML" ] || die "missing $TOML — is this an openMeet checkout?"
TMP=$(mktemp)
sed -e '/^\[env\./,$b' \
    -e "s|^database_id = \".*\"|database_id = \"$DB_ID\"|" \
    -e "s|^PAGES_ORIGIN = \".*\"|PAGES_ORIGIN = \"$PAGES_ORIGIN\"|" \
    "$TOML" > "$TMP"
mv "$TMP" "$TOML"
grep -q "$DB_ID" "$TOML" || die "failed to write database_id into wrangler.toml"
say "  database_id  $DB_ID"
say "  PAGES_ORIGIN $PAGES_ORIGIN"

step "Applying the schema"
pnpm --filter @openmeet/worker db:migrate:remote

# 4. Worker -------------------------------------------------------------------
# Deployed BEFORE the web app because the web build inlines the Worker URL.
# PAGES_ORIGIN was already read from the Pages project's real domain above, so
# this needs only one Worker deploy rather than one before and one after.
# The pipe into tee makes this deploy non-interactive, and sh has no pipefail,
# so a failed deploy does not stop the script here. A successful deploy always
# prints its workers.dev URL, so a missing URL means the deploy failed.
step "Deploying the Worker"
DEPLOY_LOG=$(mktemp)
wr deploy 2>&1 | tee "$DEPLOY_LOG"
WORKER_URL=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | head -1 || true)
# A brand-new account may have no workers.dev subdomain yet. wrangler would
# offer to register one, but only when it can prompt, which it can't here.
if [ -z "$WORKER_URL" ] && grep -q 'register a workers.dev subdomain' "$DEPLOY_LOG"; then
  rm -f "$DEPLOY_LOG"
  die "Your Cloudflare account has no workers.dev subdomain yet. Choose one at
       https://dash.cloudflare.com/?to=/:account/workers/onboarding
       then re-run install.sh (every step is reused)."
fi
rm -f "$DEPLOY_LOG"
[ -n "$WORKER_URL" ] || die "The Worker deploy failed (see wrangler's output above). Fix that, then re-run install.sh (every step is reused)."
say "  $WORKER_URL"

# 5. Pages --------------------------------------------------------------------
# NEXT_PUBLIC_API_BASE is inlined into the bundle at build time, so it goes on
# the build command. Get it wrong and the deployed site calls localhost with no
# error anywhere — which is why the build refuses to run without it.
step "Building the web app against $WORKER_URL"
NEXT_PUBLIC_API_BASE="$WORKER_URL" pnpm --filter @openmeet/web build

step "Deploying to Pages"
wr pages deploy "$ROOT/apps/web/out" \
  --project-name "$PROJECT" --branch main

# --- done --------------------------------------------------------------------
say ""
say "${G}Your openMeet is live.${N}"
say ""
say "  App     ${B}${PAGES_ORIGIN}${N}"
say "  API     ${DIM}${WORKER_URL}${N}"
say "  Repo    ${DIM}${ROOT}${N}"
say ""
say "Open it in ${B}Chrome${N}, click New Room, and share the link. The host must"
say "use a Chromium browser — recording writes files to the host's disk."
say ""
say "Two things worth doing next:"
say "  ${DIM}1.${N} TURN, or people behind strict NATs can't connect at all:"
say "     ${DIM}cd \"$ROOT\"${N}"
say "     ${DIM}printf %s '<id>'    | pnpm --filter @openmeet/worker exec wrangler secret put TURN_APP_ID${N}"
say "     ${DIM}printf %s '<token>' | pnpm --filter @openmeet/worker exec wrangler secret put TURN_API_TOKEN${N}"
say "  ${DIM}2.${N} Keep the wrangler.toml change local — it now holds YOUR database"
say "     id and origin. Don't push it to a public fork; \`git stash\` it before"
say "     pulling updates, and re-running install.sh writes it again."
