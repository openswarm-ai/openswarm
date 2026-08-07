import type { SimpleIcon } from 'simple-icons';
import {
  siAnthropic, siArxiv, siBitbucket, siCloudflare, siDiscord, siDuckduckgo, siFacebook, siFigma,
  siGithub, siGitlab, siGoogle, siHuggingface, siInstagram, siKaggle, siMedium, siMozilla,
  siNetflix, siNotion, siNpm, siPinterest, siQuora, siReddit, siSpotify, siStackoverflow,
  siSubstack, siTiktok, siTwitch, siVercel, siWikipedia, siX, siYcombinator, siYoutube,
} from 'simple-icons';

// Bundled CC0 marks instead of a favicon service: fetching icons remotely reports the user's reading list to a third party (ENG-130).
const BRAND_BY_DOMAIN: Record<string, SimpleIcon> = {
  'anthropic.com': siAnthropic,
  'arxiv.org': siArxiv,
  'bitbucket.org': siBitbucket,
  'cloudflare.com': siCloudflare,
  'discord.com': siDiscord,
  'duckduckgo.com': siDuckduckgo,
  'facebook.com': siFacebook,
  'figma.com': siFigma,
  'github.com': siGithub,
  'gitlab.com': siGitlab,
  'google.com': siGoogle,
  'huggingface.co': siHuggingface,
  'instagram.com': siInstagram,
  'kaggle.com': siKaggle,
  'medium.com': siMedium,
  'mozilla.org': siMozilla,
  'netflix.com': siNetflix,
  'notion.so': siNotion,
  'npmjs.com': siNpm,
  'pinterest.com': siPinterest,
  'quora.com': siQuora,
  'reddit.com': siReddit,
  'spotify.com': siSpotify,
  'stackoverflow.com': siStackoverflow,
  'substack.com': siSubstack,
  'tiktok.com': siTiktok,
  'twitch.tv': siTwitch,
  'twitter.com': siX,
  'vercel.com': siVercel,
  'wikipedia.org': siWikipedia,
  'x.com': siX,
  'ycombinator.com': siYcombinator,
  'youtube.com': siYoutube,
};

export function brandIconForDomain(domain: string): SimpleIcon | null {
  let host = domain.toLowerCase().replace(/^www\./, '');
  while (host.length > 0) {
    const hit = BRAND_BY_DOMAIN[host];
    if (hit !== undefined) return hit;
    const dot = host.indexOf('.');
    if (dot === -1) return null;
    host = host.slice(dot + 1);
  }
  return null;
}

// Deterministic hue, so a domain's monogram tile never changes color between renders or sessions.
export function monogramHue(domain: string): number {
  let h = 0;
  for (let i = 0; i < domain.length; i += 1) h = (h * 31 + domain.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
