import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { resetGenerateRouteState } from "./args.js";
import { assertNoSecretLeak, connectionState, saveHomeKey } from "./providers.js";

describe("BYOK minimax-cn", () => {
  it("stores the key with owner-only permissions and never echoes it", () => {
    resetGenerateRouteState();
    const prevCn = process.env.MINIMAX_CN_API_KEY;
    const prevCloud = process.env.MINIMAXCN_API_KEY;
    const prevAlias = process.env.MINIMAX_API_KEY;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
    try {
      saveHomeKey(home, "minimax-cn", "sk-test-not-for-git");
      const file = path.join(home, "credentials", "minimax-cn.key");
      assert.equal(fs.existsSync(file), true);
      if (process.platform === "win32") {
        const acl = execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$acl = Get-Acl -LiteralPath $env:DSH_TEST_KEY_FILE; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allow = @($acl.Access | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow }); $allowSids = @($allow | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique); if (-not $acl.AreAccessRulesProtected -or $allowSids.Count -ne 1 -or $allowSids[0] -ne $sid) { throw 'Key ACL is not owner-only' }; Write-Output 'owner-only'",
          ],
          { encoding: "utf8", env: { ...process.env, DSH_TEST_KEY_FILE: file } },
        );
        assert.equal(acl.trim(), "owner-only");
      } else {
        const mode = fs.statSync(file).mode & 0o777;
        assert.equal(mode, 0o600);
      }
      const state = connectionState(home, {});
      assert.equal(state.ready, true);
      assert.equal(state.source, "dsh-home");
      assert.doesNotMatch(JSON.stringify(state), /sk-test-not-for-git/);
      assert.throws(() => assertNoSecretLeak("leak sk-test-not-for-git", ["sk-test-not-for-git"]), /secret leak/);
    } finally {
      if (prevCn === undefined) delete process.env.MINIMAX_CN_API_KEY;
      else process.env.MINIMAX_CN_API_KEY = prevCn;
      if (prevCloud === undefined) delete process.env.MINIMAXCN_API_KEY;
      else process.env.MINIMAXCN_API_KEY = prevCloud;
      if (prevAlias === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = prevAlias;
      fs.rmSync(home, { recursive: true, force: true });
      resetGenerateRouteState();
    }
  });
});
