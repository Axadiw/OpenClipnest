// server/scripts/lib/prompt.ts — masked password prompt for operator CLIs.

// Key codes used while reading the masked password in raw mode.
const KEY_CTRL_C = 3;
const KEY_BACKSPACE_BS = 8;
const KEY_LF = 10;
const KEY_CR = 13;
const KEY_BACKSPACE_DEL = 127;

export async function promptPassword(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Non-TTY (piped input): read a line without echo suppression.
    return new Promise<string>((resolve, reject) => {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ''));
        }
      });
      stdin.on('error', reject);
    });
  }
  return new Promise<string>((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (key: string): void => {
      const code = key.length > 0 ? key.charCodeAt(0) : -1;
      if (code === KEY_CTRL_C) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(130);
        return;
      }
      if (code === KEY_CR || code === KEY_LF) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf);
        return;
      }
      if (code === KEY_BACKSPACE_DEL || code === KEY_BACKSPACE_BS) {
        if (buf.length > 0) buf = buf.slice(0, -1);
        return;
      }
      buf += key;
    };
    stdin.on('data', onData);
  });
}

/**
 * Password from the environment variable `envVar` when set, otherwise prompted
 * twice (with confirmation). Lets installers run non-interactively.
 */
export async function passwordFromEnvOrPrompt(envVar: string, label: string): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined) return fromEnv;
  const password = await promptPassword(`${label}: `);
  const confirm = await promptPassword('Confirm password: ');
  if (password !== confirm) {
    console.error('Passwords do not match');
    process.exit(3);
  }
  return password;
}
