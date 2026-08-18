const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRuntimePaths } = require('./runtime-paths');

function fakeFs({ files = {}, directories = [], listings = {} } = {}) {
  const dirs = new Set(directories);
  return {
    existsSync(target) {
      return dirs.has(target) || Object.hasOwn(files, target) || Object.hasOwn(listings, target);
    },
    readFileSync(target) {
      if (!Object.hasOwn(files, target)) throw new Error(`missing file: ${target}`);
      return files[target];
    },
    readdirSync(target) {
      if (!Object.hasOwn(listings, target)) throw new Error(`missing directory: ${target}`);
      return listings[target];
    },
    statSync(target) {
      if (!dirs.has(target)) throw new Error(`not a directory: ${target}`);
      return { isDirectory: () => true };
    },
  };
}

function resolver(overrides = {}) {
  return createRuntimePaths({
    isPackaged: false,
    isDev: true,
    platform: 'linux',
    arch: 'x64',
    resourcesPath: '/app/resources',
    electronDir: '/repo/electron',
    env: { PATH: '/usr/bin' },
    homedir: () => '/home/ada',
    fsImpl: fakeFs(),
    pathImpl: path.posix,
    execFileSyncImpl: () => { throw new Error('unexpected shell invocation'); },
    ...overrides,
  });
}

test('resolves development resources, project root, Python, and inherited PATH', () => {
  const paths = resolver();
  assert.equal(paths.resourcePath('backend'), '/repo/backend');
  assert.equal(paths.projectRoot(), '/repo');
  assert.equal(paths.pythonExecutable(), '/repo/backend/.venv/bin/python3');
  assert.equal(paths.pythonSitePackages(), null);
  assert.equal(paths.shellPath(), '/usr/bin');
});

test('resolves packaged Windows runtime paths', () => {
  const node = '/app/resources/node/x64/node.exe';
  const paths = resolver({
    isPackaged: true,
    isDev: false,
    platform: 'win32',
    fsImpl: fakeFs({ files: { [node]: '' } }),
  });
  assert.equal(paths.resourcePath('backend'), '/app/resources/backend');
  assert.equal(paths.projectRoot(), '/app/resources');
  assert.equal(paths.pythonExecutable(), '/app/resources/python-env/python.exe');
  assert.equal(paths.pythonSitePackages(), '/app/resources/python-env/Lib/site-packages');
  assert.equal(paths.bundledNodeExecutable(), node);
});

test('resolves the packaged macOS runtime through the Python.app wrapper when it is shipped', () => {
  const wrapper = '/app/resources/python-env/Python.app/Contents/MacOS/python3';
  const paths = resolver({
    isPackaged: true,
    isDev: false,
    platform: 'darwin',
    arch: 'arm64',
    fsImpl: fakeFs({ files: { [wrapper]: '' }, listings: { '/app/resources/python-env/lib': ['python3.13', 'site.py'] } }),
  });
  assert.equal(paths.pythonExecutable(), wrapper);
  assert.equal(paths.pythonSitePackages(), '/app/resources/python-env/lib/python3.13/site-packages');
});

test('falls back to the bare python3 binary when the macOS wrapper is missing', () => {
  const paths = resolver({
    isPackaged: true,
    isDev: false,
    platform: 'darwin',
    arch: 'arm64',
    fsImpl: fakeFs({ listings: { '/app/resources/python-env/lib': ['python3.14'] } }),
  });
  assert.equal(paths.pythonExecutable(), '/app/resources/python-env/bin/python3');
  assert.equal(paths.pythonSitePackages(), '/app/resources/python-env/lib/python3.14/site-packages');
});

test('site-packages follows whichever python3.N the bundled env ships, and fails loud on none or several', () => {
  const missing = resolver({ isPackaged: true, platform: 'linux', fsImpl: fakeFs() });
  assert.throws(() => missing.pythonSitePackages(), /Expected exactly one bundled python3\.N lib dir .* found: none/);

  const several = resolver({
    isPackaged: true,
    platform: 'linux',
    fsImpl: fakeFs({ listings: { '/app/resources/python-env/lib': ['python3.13', 'python3.14'] } }),
  });
  assert.throws(() => several.pythonSitePackages(), /found: python3\.13, python3\.14/);
});

test('returns a bundled Node executable only for a shipped supported architecture', () => {
  const armNode = '/app/resources/node/arm64/bin/node';
  const packaged = resolver({
    isPackaged: true,
    isDev: false,
    platform: 'darwin',
    arch: 'arm64',
    fsImpl: fakeFs({ files: { [armNode]: '' } }),
  });
  assert.equal(packaged.bundledNodeExecutable(), armNode);
  assert.equal(resolver({ arch: 'arm64' }).bundledNodeExecutable(), null);
  assert.equal(resolver({ isPackaged: true, isDev: false, arch: 'ia32' }).bundledNodeExecutable(), null);
  assert.equal(resolver({ isPackaged: true, isDev: false, arch: 'x64' }).bundledNodeExecutable(), null);
});

test('uses the packaged macOS login shell PATH with the expected environment', () => {
  const calls = [];
  const paths = resolver({
    isPackaged: true,
    isDev: false,
    platform: 'darwin',
    env: { PATH: '/usr/bin', SHELL: '/bin/fish', TOKEN: 'kept' },
    homedir: () => '/Users/ada',
    execFileSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return ' /opt/homebrew/bin:/usr/bin\n';
    },
  });

  assert.equal(paths.shellPath(), '/opt/homebrew/bin:/usr/bin');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/bin/fish');
  assert.deepEqual(calls[0].args, ['-ilc', 'echo $PATH']);
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[0].options.env.HOME, '/Users/ada');
  assert.equal(calls[0].options.env.TOKEN, 'kept');
});

test('builds a stable, existing-only macOS fallback PATH when the login shell fails', () => {
  const files = {
    '/etc/paths': '/usr/bin\n/bin\n',
    '/etc/paths.d/a-first': '/opt/tool-a/bin\n',
    '/etc/paths.d/z-last': '/opt/tool-z/bin\n/usr/bin\n',
  };
  const directories = [
    '/Users/ada/.nvm/versions/node/v22/bin',
    '/Users/ada/.local/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/tool-a/bin',
    '/opt/tool-z/bin',
    '/usr/bin',
    '/bin',
  ];
  const paths = resolver({
    isPackaged: true,
    isDev: false,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin:/missing' },
    homedir: () => '/Users/ada',
    fsImpl: fakeFs({
      files,
      directories,
      listings: {
        '/etc/paths.d': ['z-last', 'a-first'],
        '/Users/ada/.nvm/versions/node': ['v20', 'v22'],
      },
    }),
    execFileSyncImpl: () => { throw new Error('shell unavailable'); },
  });

  assert.equal(paths.shellPath(), [
    '/Users/ada/.nvm/versions/node/v22/bin',
    '/Users/ada/.local/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/tool-a/bin',
    '/opt/tool-z/bin',
  ].join(':'));
});
