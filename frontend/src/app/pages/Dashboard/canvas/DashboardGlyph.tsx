import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import type { LucideIcon } from 'lucide-react';
import {
  Timer, Clock, Calendar, ListChecks, Wallet, BarChart3, Megaphone, Code,
  Terminal, Palette, PenLine, FileText, BookOpen, FlaskConical, Mail,
  MessageCircle, Plane, Map, Dumbbell, HeartPulse, Utensils, ChefHat, Coffee,
  Music, Video, Image, Camera, ShoppingCart, Bot, Gamepad2, Home, Shield,
  Users, Scale, Building2, Newspaper, Briefcase, Rocket, Globe, Database,
  Wrench, Lightbulb, Target, Trophy, Bell, Folder, Package, Truck,
  LayoutDashboard, CloudSun,
} from 'lucide-react';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// Whole-word keyword -> icon. Looked up per title token (never substring), so "admin" can't trip the "ad" rule. Keep keys lowercase + singular; plurals are handled by the trailing-s strip in pickIcon. Add gerunds explicitly.
const KEYWORDS: Record<string, LucideIcon> = {
  timer: Timer, pomodoro: Timer, stopwatch: Timer, countdown: Timer, break: Timer,
  clock: Clock, reminder: Clock, alarm: Clock, deadline: Clock,
  calendar: Calendar, schedule: Calendar, planner: Calendar, planning: Calendar, agenda: Calendar, event: Calendar, booking: Calendar,
  todo: ListChecks, task: ListChecks, checklist: ListChecks, kanban: ListChecks, backlog: ListChecks, sprint: ListChecks, chore: ListChecks,
  money: Wallet, budget: Wallet, finance: Wallet, financial: Wallet, expense: Wallet, invoice: Wallet, payment: Wallet, billing: Wallet, wallet: Wallet, accounting: Wallet,
  sales: BarChart3, revenue: BarChart3, growth: BarChart3, metric: BarChart3, kpi: BarChart3, analytics: BarChart3, stats: BarChart3, dashboard: BarChart3, report: BarChart3, reporting: BarChart3,
  marketing: Megaphone, market: Megaphone, campaign: Megaphone, ad: Megaphone, promo: Megaphone, brand: Megaphone, branding: Megaphone, seo: Megaphone,
  code: Code, coding: Code, dev: Code, developer: Code, engineer: Code, engineering: Code, build: Code, api: Code, backend: Code, frontend: Code, repo: Code, git: Code, software: Code,
  terminal: Terminal, shell: Terminal, cli: Terminal, script: Terminal, command: Terminal, devops: Terminal,
  design: Palette, designing: Palette, ui: Palette, ux: Palette, figma: Palette, mockup: Palette, wireframe: Palette, prototype: Palette,
  write: PenLine, writing: PenLine, blog: PenLine, content: PenLine, copy: PenLine, copywriting: PenLine, essay: PenLine, note: PenLine, journal: PenLine,
  doc: FileText, document: FileText, documentation: FileText, paper: FileText, pdf: FileText, spec: FileText,
  research: BookOpen, study: BookOpen, learning: BookOpen, course: BookOpen, education: BookOpen, school: BookOpen, exam: BookOpen, thesis: BookOpen,
  science: FlaskConical, lab: FlaskConical, experiment: FlaskConical, chemistry: FlaskConical, biology: FlaskConical, physics: FlaskConical,
  mail: Mail, email: Mail, inbox: Mail, outreach: Mail, newsletter: Mail,
  chat: MessageCircle, message: MessageCircle, messaging: MessageCircle, support: MessageCircle, dm: MessageCircle,
  travel: Plane, trip: Plane, flight: Plane, vacation: Plane, tour: Plane, itinerary: Plane,
  map: Map, location: Map, geo: Map, route: Map, navigation: Map,
  fitness: Dumbbell, workout: Dumbbell, gym: Dumbbell, exercise: Dumbbell, training: Dumbbell,
  health: HeartPulse, medical: HeartPulse, doctor: HeartPulse, patient: HeartPulse, clinic: HeartPulse, wellness: HeartPulse, therapy: HeartPulse,
  food: Utensils, recipe: Utensils, cooking: Utensils, cook: Utensils, kitchen: Utensils, meal: Utensils, diet: Utensils, nutrition: Utensils,
  restaurant: ChefHat, chef: ChefHat, menu: ChefHat,
  coffee: Coffee, cafe: Coffee, brew: Coffee,
  music: Music, song: Music, audio: Music, playlist: Music, podcast: Music,
  video: Video, film: Video, movie: Video, stream: Video, streaming: Video, youtube: Video,
  photo: Image, photography: Image, gallery: Image, picture: Image,
  camera: Camera, shoot: Camera,
  shop: ShoppingCart, shopping: ShoppingCart, store: ShoppingCart, ecommerce: ShoppingCart, cart: ShoppingCart, order: ShoppingCart, product: ShoppingCart, retail: ShoppingCart,
  ai: Bot, agent: Bot, bot: Bot, swarm: Bot, llm: Bot, gpt: Bot, automation: Bot,
  game: Gamepad2, gaming: Gamepad2, gamedev: Gamepad2,
  home: Home, house: Home, apartment: Home, household: Home,
  security: Shield, auth: Shield, login: Shield, password: Shield, secure: Shield, privacy: Shield,
  team: Users, people: Users, community: Users, hr: Users, customer: Users, user: Users, crm: Users, contacts: Users,
  law: Scale, legal: Scale, contract: Scale, policy: Scale, compliance: Scale, regulation: Scale,
  property: Building2, estate: Building2, building: Building2, office: Building2,
  news: Newspaper, article: Newspaper, press: Newspaper, media: Newspaper, journalism: Newspaper,
  work: Briefcase, job: Briefcase, career: Briefcase, business: Briefcase, client: Briefcase, project: Briefcase, portfolio: Briefcase,
  launch: Rocket, startup: Rocket, rocket: Rocket, release: Rocket, roadmap: Rocket,
  web: Globe, site: Globe, website: Globe, domain: Globe, browser: Globe, internet: Globe,
  data: Database, database: Database, sql: Database, warehouse: Database, pipeline: Database, etl: Database,
  fix: Wrench, repair: Wrench, maintenance: Wrench, tool: Wrench, utility: Wrench,
  idea: Lightbulb, brainstorm: Lightbulb, inspiration: Lightbulb,
  goal: Target, target: Target, okr: Target, objective: Target,
  award: Trophy, trophy: Trophy, achievement: Trophy, leaderboard: Trophy, contest: Trophy,
  notification: Bell, alert: Bell,
  archive: Folder, collection: Folder, library: Folder,
  inventory: Package, stock: Package, package: Package, supply: Package,
  delivery: Truck, shipping: Truck, logistics: Truck, truck: Truck, fleet: Truck,
  weather: CloudSun, forecast: CloudSun, temperature: CloudSun,
};

export function pickIcon(title: string): LucideIcon | null {
  const words = title.toLowerCase().match(/[a-z]+/g) || [];
  for (const w of words) {
    const hit = KEYWORDS[w] || (w.endsWith('s') ? KEYWORDS[w.slice(0, -1)] : undefined);
    if (hit) return hit;
  }
  return null;
}

interface DashboardGlyphProps {
  name: string | undefined;
  size?: number;
  color?: string;
}

const DashboardGlyph: React.FC<DashboardGlyphProps> = ({ name, size = 16, color }) => {
  const c = useClaudeTokens();
  const glyphColor = color || c.accent.primary;
  const title = (name || '').trim();
  const Icon = useMemo(() => (title ? pickIcon(title) : null), [title]);

  if (Icon) {
    return <Icon size={size} strokeWidth={1.75} color={glyphColor} />;
  }

  // No keyword hit: a tinted monogram of the first letter. Honest identity, never a misleading icon. A title with no latin letters falls back to the glyph.
  const letter = title.match(/[a-z0-9]/i)?.[0]?.toUpperCase();
  if (!letter) {
    return <LayoutDashboard size={size} strokeWidth={1.75} color={glyphColor} />;
  }
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: '4px',
        bgcolor: color ? 'rgba(255,255,255,0.16)' : `${c.accent.primary}1F`,
        color: glyphColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.62,
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {letter}
    </Box>
  );
};

export default DashboardGlyph;
