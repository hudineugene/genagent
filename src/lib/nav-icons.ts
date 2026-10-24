import {
  Activity,
  BellRing,
  Blocks,
  BookOpen,
  BookOpenCheck,
  Calculator,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  FileBarChart2,
  FileText,
  FlaskConical,
  Gift,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  Mail,
  Megaphone,
  MessageCircleQuestion,
  Mic,
  Network,
  PenLine,
  Radio,
  Repeat,
  Route,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Truck,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * Значки разделов по имени: меню клиента и агента собирается на сервере, а рисуется и на сервере, и в панели слева
 * (клиентский компонент) — по сети передаётся имя значка, не сам компонент.
 */
export const NAV_ICONS = {
  activity: Activity,
  bellRing: BellRing,
  blocks: Blocks,
  bookOpen: BookOpen,
  bookOpenCheck: BookOpenCheck,
  calculator: Calculator,
  clipboardCheck: ClipboardCheck,
  clipboardList: ClipboardList,
  creditCard: CreditCard,
  fileBarChart: FileBarChart2,
  fileText: FileText,
  flask: FlaskConical,
  gift: Gift,
  graduationCap: GraduationCap,
  layoutDashboard: LayoutDashboard,
  listChecks: ListChecks,
  mail: Mail,
  megaphone: Megaphone,
  question: MessageCircleQuestion,
  mic: Mic,
  network: Network,
  penLine: PenLine,
  radio: Radio,
  repeat: Repeat,
  route: Route,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  table: Table2,
  truck: Truck,
  users: Users,
  wrench: Wrench,
} satisfies Record<string, LucideIcon>;

export type NavIcon = keyof typeof NAV_ICONS;
export type SectionItem = { key: string; label: string; icon: NavIcon; n?: number; alert?: number; always?: boolean };
export type SectionGroup = { title?: string; tone: string; items: SectionItem[] };

/** Меню разделов для показа: всегда видимые, настроенные, с тревогой и открытый сейчас; пустые группы скрыты. */
export function visibleNav(nav: SectionGroup[], active: string): SectionGroup[] {
  return nav.map((g) => ({ ...g, items: g.items.filter((i) => i.always || i.n || i.alert || i.key === active) })).filter((g) => g.items.length);
}
