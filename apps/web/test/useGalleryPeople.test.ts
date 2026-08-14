import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGalleryPeople } from "../src/features/gallery/useGalleryPeople";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const { api } = await import("../src/api");
const mockApi = vi.mocked(api);

const deps = (over: Partial<{ isAdmin: boolean }> = {}) => ({
  setLoading: vi.fn(),
  setError: vi.fn(),
  setNotice: vi.fn(),
  scopeParams: () => ({ scope: "all" }),
  isAdmin: true,
  ...over
});
const asset = (id: string) => ({ id, title: id }) as never;

beforeEach(() => mockApi.mockReset());

describe("useGalleryPeople", () => {
  it("scopes the people request with whatever scopeParams returns", async () => {
    const d = { ...deps(), scopeParams: () => ({ scope: "library", libraryId: "lib7" }) };
    mockApi.mockResolvedValueOnce({ people: [] });
    const { result } = renderHook(() => useGalleryPeople(d));

    await act(() => result.current.loadPeople());

    expect(String(mockApi.mock.calls[0][0])).toContain("scope=library");
    expect(String(mockApi.mock.calls[0][0])).toContain("libraryId=lib7");
  });

  it("does not read face settings for a non-admin", async () => {
    const { result } = renderHook(() => useGalleryPeople(deps({ isAdmin: false })));
    await act(() => result.current.loadFaceSettings());
    expect(mockApi).not.toHaveBeenCalled();
  });

  it("reports whether any library has face recognition on", async () => {
    const { result } = renderHook(() => useGalleryPeople(deps()));
    expect(result.current.anyFaceEnabled).toBe(false);

    mockApi.mockResolvedValueOnce({ libraries: [{ id: "l1", enabled: false }, { id: "l2", enabled: true }] });
    await act(() => result.current.loadFaceSettings());

    expect(result.current.anyFaceEnabled).toBe(true);
  });

  // The behaviour that made the picker safe to keep across navigation: a
  // half-made selection must not survive a switch to a different person, or it
  // would be applied to the wrong cluster.
  it("clears a half-made photo selection when the open person changes", async () => {
    const { result } = renderHook(() => useGalleryPeople(deps()));

    mockApi.mockResolvedValueOnce({ person: { id: "person-1", name: "Ada", coverItemId: null }, assets: [asset("p1")], total: 1 });
    await act(() => result.current.openPerson({ id: "person-1", name: "Ada" }));
    act(() => result.current.setPersonPick(new Set(["p1"])));
    expect(result.current.personPick?.size).toBe(1);

    mockApi.mockResolvedValueOnce({ person: { id: "person-2", name: "Grace", coverItemId: null }, assets: [asset("p2")], total: 1 });
    await act(() => result.current.openPerson({ id: "person-2", name: "Grace" }));

    expect(result.current.personPick).toBeNull();
  });

  it("keeps the selection while the same person stays open", async () => {
    const { result } = renderHook(() => useGalleryPeople(deps()));
    mockApi.mockResolvedValueOnce({ person: { id: "person-1", name: "Ada", coverItemId: null }, assets: [asset("p1"), asset("p2")], total: 2 });
    await act(() => result.current.openPerson({ id: "person-1", name: "Ada" }));

    act(() => result.current.setPersonPick(new Set()));
    act(() => result.current.togglePersonPick("p1"));
    act(() => result.current.togglePersonPick("p2"));
    act(() => result.current.togglePersonPick("p1"));

    expect([...(result.current.personPick ?? [])]).toEqual(["p2"]);
  });

  it("ignores a pick toggle when the picker is not open", () => {
    const { result } = renderHook(() => useGalleryPeople(deps()));
    act(() => result.current.togglePersonPick("p1"));
    expect(result.current.personPick).toBeNull();
  });

  it("renames the open person and keeps the header in step", async () => {
    const { result } = renderHook(() => useGalleryPeople(deps()));
    mockApi.mockResolvedValueOnce({ person: { id: "person-1", name: "Unnamed", coverItemId: null }, assets: [], total: 0 });
    await act(() => result.current.openPerson({ id: "person-1", name: "Unnamed" }));

    act(() => result.current.setRenameValue("  Ada Lovelace  "));
    mockApi.mockResolvedValueOnce({}).mockResolvedValueOnce({ people: [] });
    await act(() => result.current.submitRename());

    expect(JSON.parse(String(mockApi.mock.calls[1][1]?.body))).toEqual({ name: "Ada Lovelace" });
    expect(result.current.selectedPerson?.name).toBe("Ada Lovelace");
    expect(result.current.renameValue).toBeNull();
  });

  it("refuses to rename to blank", async () => {
    const { result } = renderHook(() => useGalleryPeople(deps()));
    mockApi.mockResolvedValueOnce({ person: { id: "person-1", name: "Ada", coverItemId: null }, assets: [], total: 0 });
    await act(() => result.current.openPerson({ id: "person-1", name: "Ada" }));
    mockApi.mockClear();

    act(() => result.current.setRenameValue("   "));
    await act(() => result.current.submitRename());

    expect(mockApi).not.toHaveBeenCalled();
  });

  it("moves the picked photos out of the grid and counts them off", async () => {
    const d = deps();
    const { result } = renderHook(() => useGalleryPeople(d));
    mockApi.mockResolvedValueOnce({ person: { id: "person-1", name: "Ada", coverItemId: null }, assets: [asset("p1"), asset("p2"), asset("p3")], total: 3 });
    await act(() => result.current.openPerson({ id: "person-1", name: "Ada" }));
    act(() => result.current.setPersonPick(new Set(["p1", "p3"])));

    mockApi.mockResolvedValueOnce({ moved: 2 }).mockResolvedValueOnce({ people: [] });
    await act(() => result.current.movePickedPhotos({ name: "Grace" }));

    expect(result.current.personAssets.map((a) => a.id)).toEqual(["p2"]);
    expect(result.current.personTotal).toBe(1);
    expect(result.current.personPick).toBeNull();
    expect(d.setNotice).toHaveBeenCalledWith("2 photos moved.");
  });

  it("says photo, not photos, when only one moved", async () => {
    const d = deps();
    const { result } = renderHook(() => useGalleryPeople(d));
    mockApi.mockResolvedValueOnce({ person: { id: "person-1", name: "Ada", coverItemId: null }, assets: [asset("p1")], total: 1 });
    await act(() => result.current.openPerson({ id: "person-1", name: "Ada" }));
    act(() => result.current.setPersonPick(new Set(["p1"])));

    mockApi.mockResolvedValueOnce({ moved: 1 }).mockResolvedValueOnce({ people: [] });
    await act(() => result.current.movePickedPhotos({ intoId: "person-2" }));

    expect(d.setNotice).toHaveBeenCalledWith("1 photo moved.");
  });

  it("does not move anything when nothing is picked", async () => {
    const { result } = renderHook(() => useGalleryPeople(deps()));
    mockApi.mockResolvedValueOnce({ person: { id: "person-1", name: "Ada", coverItemId: null }, assets: [asset("p1")], total: 1 });
    await act(() => result.current.openPerson({ id: "person-1", name: "Ada" }));
    mockApi.mockClear();

    act(() => result.current.setPersonPick(new Set()));
    await act(() => result.current.movePickedPhotos({ intoId: "person-2" }));

    expect(mockApi).not.toHaveBeenCalled();
  });
});
