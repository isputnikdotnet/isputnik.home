import { Laptop, Monitor, ShieldQuestion, Smartphone, Tablet, type LucideIcon } from "lucide-react";
import type { DeviceType } from "../../types";

// One glyph per device kind, shared by the devices table and the sign-ins
// table so a phone looks the same whether it is signed in or was just refused.
export const DEVICE_ICONS: Record<DeviceType, LucideIcon> = {
  display: Monitor,
  phone: Smartphone,
  tablet: Tablet,
  computer: Laptop,
  unknown: ShieldQuestion
};
