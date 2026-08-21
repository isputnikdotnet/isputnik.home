import { useCallback, useState } from "react";
import { SelectMenu } from "./SelectMenu";

// "How many rows at a time", for the tables that offer the choice. The value is
// remembered per table (its own storage key), because someone who wants 100 login
// rows does not necessarily want 100 devices.

export const PAGE_SIZES = ["10", "20", "50", "100"] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

const DEFAULT_PAGE_SIZE: PageSize = "20";

export function usePageSize(storageKey: string): [PageSize, (next: PageSize) => void] {
  const [size, setSize] = useState<PageSize>(() => {
    const saved = window.localStorage.getItem(storageKey);
    return PAGE_SIZES.includes(saved as PageSize) ? (saved as PageSize) : DEFAULT_PAGE_SIZE;
  });

  const choose = useCallback(
    (next: PageSize) => {
      setSize(next);
      window.localStorage.setItem(storageKey, next);
    },
    [storageKey]
  );

  return [size, choose];
}

export function PageSizeMenu({ value, onChange }: { value: PageSize; onChange: (next: PageSize) => void }) {
  return (
    <SelectMenu
      value={value}
      options={PAGE_SIZES.map((size) => ({ value: size, label: `${size} per page` }))}
      label="Rows per page"
      onChange={onChange}
    />
  );
}
