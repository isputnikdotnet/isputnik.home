import {
  BookOpen, Search, Rocket, Heart, Landmark, Briefcase, FlaskConical, Baby, LayoutGrid,
  Ghost, Sword, Globe, Star, Sparkles, Music, Mic, GraduationCap, Map, Skull, Drama, Laugh,
  Compass, Castle, Bird, Radio, Archive, Library, Podcast, Fingerprint, Church, type LucideIcon
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
  "laugh": Laugh,
  "graduation-cap": GraduationCap,
  "map": Map,
  "skull": Skull,
  "drama": Drama,
  "compass": Compass,
  "castle": Castle,
  "bird": Bird,
  "radio": Radio,
  "archive": Archive,
  "library": Library,
  "podcast": Podcast,
  "fingerprint": Fingerprint,
  "church": Church
};

export const CATEGORY_ICON_KEYS = Object.keys(CATEGORY_ICONS);

export function CategoryIcon({ icon, size = 18 }: { icon: string | null; size?: number }) {
  const Icon = (icon && CATEGORY_ICONS[icon]) || LayoutGrid;
  return <Icon size={size} aria-hidden="true" />;
}

// Deterministic accent tint (1..6) for a category's browse tile, derived from its
// stable key so the colour never shifts between renders and any newly-added category
// gets one for free. Maps to the .category-tint-N classes in library-collections.css,
// which build the fill from the theme's own accent vars (works across every theme).
const CATEGORY_TINT_COUNT = 6;
export function categoryTint(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) >>> 0;
  return (hash % CATEGORY_TINT_COUNT) + 1;
}
