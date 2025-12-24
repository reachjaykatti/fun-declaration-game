// src/utils/backupToGitHub.js
import fs from "fs";
import path from "path";
import archiver from "archiver";
import simpleGit from "simple-git";
import cron from "node-cron";

const DATA_DIR = process.env.NODE_ENV === "production"
  ? "/opt/render/project/data"
  : path.join(process.cwd(), "data");

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const REPO_URL = process.env.BACKUP_GITHUB_REPO; // e.g. https://github.com/reachjaykatti/fun-declaration-game.git
const GIT_EMAIL = process.env.GIT_EMAIL || "backup-bot@example.com";
const GIT_NAME = process.env.GIT_NAME || "Render Backup Bot";

// Ensure backup folder exists
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Helper to zip all DB files
async function createBackupZip() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const zipPath = path.join(BACKUP_DIR, `backup-${timestamp}.zip`);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve(zipPath));
    archive.on("error", reject);

    archive.pipe(output);
    archive.glob("*.db", { cwd: DATA_DIR }); // includes app.db and sessions.db
    archive.finalize();
  });
}

// Helper to push to GitHub
async function pushToGitHub(zipPath) {
  const git = simpleGit();

  await git.addConfig("user.email", GIT_EMAIL);
  await git.addConfig("user.name", GIT_NAME);

  try {
    // Check if backup branch exists
    const branches = await git.branch();
    const branchName = "render-backups";
    if (!branches.all.includes(branchName)) {
      await git.checkoutLocalBranch(branchName);
    } else {
      await git.checkout(branchName);
    }

    fs.copyFileSync(zipPath, path.basename(zipPath));
    await git.add(path.basename(zipPath));
    await git.commit(`Backup on ${new Date().toISOString()}`);
    await git.push(REPO_URL, branchName);
    console.log(`✅ Backup pushed to branch '${branchName}'`);
  } catch (err) {
    console.error("❌ Git backup failed:", err);
  }
}

// Main task
async function performBackup() {
  try {
    const zipPath = await createBackupZip();
    console.log("📦 Created backup:", zipPath);
    await pushToGitHub(zipPath);
  } catch (err) {
    console.error("❌ Backup error:", err);
  }
}

// Schedule backup every day at 2:30 AM UTC
cron.schedule("30 2 * * *", async () => {
  console.log("🕑 Running scheduled backup...");
  await performBackup();
});

// Also allow manual trigger (for testing)
if (process.env.RUN_BACKUP_NOW === "true") {
  await performBackup();
}
