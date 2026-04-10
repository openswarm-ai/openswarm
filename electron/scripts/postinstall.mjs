// electron/scripts/postinstall.mjs
// Cross-platform postinstall — runs VMP signing on macOS only.
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const signScript = join(__dirname, 'sign-vmp.sh');

if (process.platform === 'darwin' && existsSync(signScript)) {
  try {
    execFileSync('bash', [signScript], { stdio: 'inherit' });
  } catch (err) {
    console.warn('[postinstall] VMP signing failed (non-fatal):', err.message);
  }
} else {
  console.log('[postinstall] Skipping VMP signing (macOS only)');
}
