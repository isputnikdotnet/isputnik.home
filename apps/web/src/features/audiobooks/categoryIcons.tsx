import {
  BookOpen, Search, Rocket, Heart, Landmark, Briefcase, FlaskConical, Baby, LayoutGrid,
  Ghost, Sword, Globe, Star, Sparkles, Music, Mic, GraduationCap, Map, Skull, Drama,
  Compass, Castle, Bird, type LucideIcon
} from "lucide-react";

// Curated set the admin can pick from. Keys are stored in categories.icon (kebab-case
// to match lucide names); values are the components from the already-bundled icon set.
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  "book-open": BookOpen,
  "search": Search,
  "rocket": Rocket,
  "heart": Heart,
  "landmark": Landmark,
  "briefcase": Briefcase,
  "flask-conical": FlaskConical,
  "baby": Baby,
  "layout-grid": LayoutGrid,
  "ghost": Ghost,
  "sword": Sword,
  "globe": Globe,
  "star": Star,
  "sparkles": Sparkles,
  "music": Music,
  "mic": Mic,
  "graduation-cap": GraduationCap,
  "map": Map,
  "skull": Skull,
  "drama": Drama,
  "compass": Compass,
  "castle": Castle,
  "bird": Bird
};

export const CATEGORY_ICON_KEYS = Object.keys(CATEGORY_ICONS);

export function CategoryIcon({ icon, size = 18 }: { icon: string | null; size?: number }) {
  const Icon = (icon && CATEGORY_ICONS[icon]) || LayoutGrid;
  return <Icon size={size} aria-hidden="true" />;
}
