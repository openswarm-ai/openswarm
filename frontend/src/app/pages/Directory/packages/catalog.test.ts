import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { driveStreamUrl, isBundle, parseBundleItems, parseTags, parseVideoUrls, resolveBundleMembers, videoEmbed, type Listing } from './catalog';

function listing(over: Partial<Listing>): Listing {
  return {
    id: 'x', title: 'X', kind: 'skill', version: '', author: '', description: '', tags: '',
    download_url: '', icon_url: '', video_url: '', size: '', updated_at: '',
    bundle_items: '', notion_url: '', details_json: '', ...over,
  };
}

test('a bundle resolves its members in its own order and drops ids that no longer exist', () => {
  const bundle = listing({ id: 'pack', kind: 'bundle', bundle_items: 'b, a, gone, a' });
  const all = [bundle, listing({ id: 'a' }), listing({ id: 'b' })];
  assert.deepEqual(resolveBundleMembers(bundle, all).map((m) => m.id), ['b', 'a']);
  assert.equal(isBundle(bundle), true);
  assert.deepEqual(parseBundleItems('b, a, , a'), ['b', 'a'], 'a repeated id is listed once');
});

test('a bundle never lists itself, which would install it forever', () => {
  const bundle = listing({ id: 'pack', kind: 'bundle', bundle_items: 'pack, a' });
  assert.deepEqual(resolveBundleMembers(bundle, [bundle, listing({ id: 'a' })]).map((m) => m.id), ['a']);
});

test('tags survive sloppy spacing and empty cells', () => {
  assert.deepEqual(parseTags(' notion ,  productivity ,,'), ['notion', 'productivity']);
  assert.deepEqual(parseTags(''), []);
});

test('a Drive video link becomes a byte stream a video tag can actually play', () => {
  assert.equal(
    driveStreamUrl('https://drive.google.com/file/d/1AbCdEf/preview'),
    'https://drive.usercontent.google.com/download?id=1AbCdEf&export=download',
  );
});

test('a YouTube listing embeds the player, a Drive listing streams the file', () => {
  assert.equal(videoEmbed('https://youtu.be/abcdefghijk')?.kind, 'youtube');
  assert.equal(videoEmbed('https://drive.google.com/file/d/1AbCdEf/preview')?.kind, 'file');
  assert.equal(videoEmbed(''), null);
});

test('several demo videos in one cell keep their order, primary first', () => {
  assert.deepEqual(parseVideoUrls('https://a\n\nhttps://b\n'), ['https://a', 'https://b']);
});

// The store tab is the marketplace's front door, so it must be the row that opens by default.
test('Packages is the default marketplace tab and the old skills store is gone', () => {
  const dir = path.join(process.cwd(), 'src/app/pages/Directory');
  const body = fs.readFileSync(path.join(dir, 'MarketplaceBody.tsx'), 'utf8');
  assert.match(body, /useState<DirectoryTab>\('packages'\)/);
  assert.match(body, /railRow\('packages', 'Packages'/);
  assert.doesNotMatch(body, /DirectorySkillsTab/);
  assert.equal(fs.existsSync(path.join(dir, 'DirectorySkillsTab.tsx')), false);
  const open = fs.readFileSync(path.join(dir, 'openMarketplace.ts'), 'utf8');
  assert.match(open, /DirectoryTab = 'packages'/);
});

// Install must not grow a second write path; it stages and lets the shared confirm surface decide.
test('the packages tab installs through the shared bundle import, not its own writer', () => {
  const tab = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Directory/DirectoryPackagesTab.tsx'), 'utf8');
  assert.match(tab, /importNeedsConfirm/);
  assert.match(tab, /importCommit/);
  assert.match(tab, /<ImportModal/);
  const gate = tab.indexOf('importNeedsConfirm(preflight)');
  const commit = tab.indexOf('else await commit(preflight');
  assert.ok(gate > 0 && commit > gate, 'the confirm gate is asked BEFORE anything is committed');
});
