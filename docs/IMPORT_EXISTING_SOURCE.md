# Import the Existing Synology ReelHouse Source

The existing source tree is expected at:

`/volume1/docker/reelhouse`

The GitHub repository now contains control-plane and architecture files. Do **not** initialize a second unrelated application over the existing Synology tree.

## Recommended import

From an SSH shell on the Synology:

```bash
cd /volume1/docker/reelhouse

# Preserve any local environment/secrets before doing anything.
git status 2>/dev/null || true

# If this directory is not already a Git repository:
git init
git branch -M main
git remote add origin git@github.com:valiford/reelhouse.git

# Bring down the repository bootstrap first so its control-plane files are preserved.
git fetch origin
git checkout -B main origin/main

# Restore/copy the existing ReelHouse application files into this working tree
# if checkout replaced an untracked source staging area. Do not copy .env or secrets.

git add .
git status

# Inspect before committing. Secrets, media, caches, databases, and generated files must not be staged.
git commit -m "Import existing Synology ReelHouse application source"
git push origin main
```

## Safer alternative when the live directory must not be disturbed

Clone beside it, then copy source files:

```bash
cd /volume1/docker
git clone git@github.com:valiford/reelhouse.git reelhouse-repo

rsync -av \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'secrets' \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude 'cache' \
  reelhouse/ reelhouse-repo/

cd reelhouse-repo
git status
git add .
git commit -m "Import existing Synology ReelHouse application source"
git push origin main
```

The second approach is preferred when `/volume1/docker/reelhouse` is the currently running deployment tree.
