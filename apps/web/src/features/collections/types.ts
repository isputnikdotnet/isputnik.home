export interface CollectionSummary {
  id: string;
  name: string;
  description: string | null;
  itemCount: number;
  coverUrls: string[];
  createdAt: string;
  updatedAt: string;
  // Present only when the list was queried with an entity ref (add-to dialog).
  containsItem?: boolean;
  itemId?: string;
}

export interface CollectionItem {
  id: string;
  entityType: string;
  entityId: string;
  position: number;
  addedAt: string;
  available: boolean;
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  durationSeconds: number | null;
  fileCount: number;
  href: string;
  playable: boolean;
}

export interface CollectionDetail {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  items: CollectionItem[];
}
