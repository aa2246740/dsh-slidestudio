import { execFile } from "node:child_process";
import fs from "node:fs";

/**
 * Resident memory in MB of the converter process group.
 * Linux walks /proc: a sandbox starts its own session, so its processes leave
 * the group but stay descendants of the process the converter spawned.
 * macOS has no /proc and keeps every process in the group, so `ps` selects them.
 * @param {number} pgid
 * @param {string} [platform]
 * @returns {Promise<number>}
 */
export async function sampleGroupRssMb(pgid, platform = process.platform) {
  if (!Number.isInteger(pgid) || pgid <= 1) return 0;
  return platform === "linux" ? linuxTreeRssMb(pgid) : psGroupRssMb(pgid);
}

/** @param {number} pgid */
function psGroupRssMb(pgid) {
  return new Promise((resolve) => {
    try {
      execFile("/bin/ps", ["-o", "rss=", "-g", String(pgid)], { timeout: 2000, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(0);
        const kib = String(stdout)
          .split("\n")
          .reduce((sum, line) => sum + (Number.parseInt(line, 10) || 0), 0);
        resolve(Math.round(kib / 1024));
      });
    } catch {
      resolve(0);
    }
  });
}

/** @param {number} rootPid */
async function linuxTreeRssMb(rootPid) {
  try {
    const names = (await fs.promises.readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const rows = (
      await Promise.all(
        names.map(async (name) => {
          try {
            const stat = await fs.promises.readFile(`/proc/${name}/stat`, "utf8");
            // The command name sits in parentheses and may contain spaces.
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            return { pid: Number(name), ppid: Number(fields[1]), pgrp: Number(fields[2]) };
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((row) => row !== undefined);
    const members = new Set([rootPid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) {
        if (!members.has(row.pid) && (row.pgrp === rootPid || members.has(row.ppid))) {
          members.add(row.pid);
          grew = true;
        }
      }
    }
    let kib = 0;
    for (const pid of members) {
      try {
        const status = await fs.promises.readFile(`/proc/${pid}/status`, "utf8");
        kib += Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1] ?? 0);
      } catch {
        // The process exited between the listing and the read.
      }
    }
    return Math.round(kib / 1024);
  } catch {
    return 0;
  }
}
