// Client shapes for the Access dialog (server: modules/users/access-routes.ts and
// modules/library/gallery/people-access-routes.ts).

export type SubjectType = "user" | "group";
export type GrantRole = "viewer" | "member" | "contributor" | "manager" | "deny";

export interface AccessSubject {
  subjectType: SubjectType;
  subjectId: string;
}

export interface InheritedGrant {
  via: "group" | "everyone";
  groupId?: string;
  groupName?: string;
  role: GrantRole;
}

export interface GrantView {
  direct: GrantRole | null;
  inherited: InheritedGrant[];
  /** What a user ends up with; null for a group. */
  effective: Exclude<GrantRole, "deny"> | null;
}

export interface AccessOverview {
  subject:
    | { subjectType: "user"; subjectId: string; name: string; email: string; role: "admin" | "member"; isActive: boolean }
    | { subjectType: "group"; subjectId: string; name: string; system: boolean; members: { id: string; name: string; email: string }[] };
  groups: { id: string; name: string }[];
  libraries: (GrantView & { id: string; name: string; type: string })[];
  branches: (GrantView & { id: string; name: string; people: number })[];
  collections: (GrantView & { id: string; name: string })[];
  inbox: GrantView | null;
  /** The family tree: open unless blocked (D14); living details follow a setting (D15). */
  tree: { blocked: boolean; blockedBy: (string | null)[]; canSee: boolean; seesLivingDetails: boolean | null };
  shares: {
    id: string;
    module: string;
    resourceId: string;
    permission: string;
    createdAt: string;
    expiresAt: string | null;
    from: string | null;
    title: string | null;
  }[];
}

export interface PersonShareCounts {
  shared: number;
  toReview: number;
  excluded: number;
}

export interface PeopleAccess {
  people: {
    id: string;
    name: string;
    direct: boolean;
    viaGroups: { id: string; name: string }[];
    counts: PersonShareCounts;
  }[];
  settings: { showLocation: boolean; showLivingDetails: boolean };
  photoCount: number;
}

export type UserTab = "account" | "groups" | "libraries" | "photos" | "family" | "shared";
export type GroupTab = "members" | "libraries" | "photos" | "family";
export type AccessTab = UserTab | GroupTab;
