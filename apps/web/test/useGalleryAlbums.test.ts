import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGalleryAlbums } from "../src/features/gallery/useGalleryAlbums";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const { api } = await import("../src/api");
const mockApi = vi.mocked(api);

const status = () => ({ setLoading: vi.fn(), setError: vi.fn(), setNotice: vi.fn() });
const asset = (id: string) => ({ id, title: id }) as never;

beforeEach(() => mockApi.mockReset());

describe("useGalleryAlbums", () => {
  it("loads the album list and reports loading either side of it", async () => {
    const s = status();
    mockApi.mockResolvedValueOnce({ albums: [{ id: "a1", name: "Trip" }] });
    const { result } = renderHook(() => useGalleryAlbums(s));

    await act(() => result.current.loadAlbums());

    expect(result.current.albums).toEqual([{ id: "a1", name: "Trip" }]);
    expect(s.setLoading).toHaveBeenNthCalledWith(1, true);
    expect(s.setLoading).toHaveBeenLastCalledWith(false);
    expect(s.setError).toHaveBeenCalledWith("");
  });

  it("surfaces a failure as the page error, and still stops loading", async () => {
    const s = status();
    mockApi.mockRejectedValueOnce(new Error("network is down"));
    const { result } = renderHook(() => useGalleryAlbums(s));

    await act(() => result.current.loadAlbums());

    expect(s.setError).toHaveBeenLastCalledWith("network is down");
    expect(s.setLoading).toHaveBeenLastCalledWith(false);
  });

  it("replaces the grid at offset 0 and appends after it — this is the paging contract", async () => {
    const { result } = renderHook(() => useGalleryAlbums(status()));

    mockApi.mockResolvedValueOnce({ album: { id: "a1" }, assets: [asset("p1")], total: 3 });
    await act(() => result.current.openAlbum("a1"));
    expect(result.current.albumAssets.map((a) => a.id)).toEqual(["p1"]);

    mockApi.mockResolvedValueOnce({ album: { id: "a1" }, assets: [asset("p2")], total: 3 });
    await act(() => result.current.openAlbum("a1", 1));
    expect(result.current.albumAssets.map((a) => a.id)).toEqual(["p1", "p2"]);

    mockApi.mockResolvedValueOnce({ album: { id: "a1" }, assets: [asset("p9")], total: 3 });
    await act(() => result.current.openAlbum("a1"));
    expect(result.current.albumAssets.map((a) => a.id)).toEqual(["p9"]);
  });

  it("refuses to create an album with a blank name, without calling the API", async () => {
    const { result } = renderHook(() => useGalleryAlbums(status()));
    act(() => result.current.setAlbumNewName("   "));

    await act(() => result.current.createAlbumSubmit());

    expect(mockApi).not.toHaveBeenCalled();
  });

  it("clears the form and reloads the list after creating one", async () => {
    const { result } = renderHook(() => useGalleryAlbums(status()));
    act(() => { result.current.setAlbumNewName("Trip"); result.current.setAlbumNewDesc("notes"); });

    mockApi.mockResolvedValueOnce({}).mockResolvedValueOnce({ albums: [{ id: "a1", name: "Trip" }] });
    await act(() => result.current.createAlbumSubmit());

    const [path, init] = mockApi.mock.calls[0];
    expect(path).toBe("/api/library/gallery/albums");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Trip", description: "notes" });
    await waitFor(() => expect(result.current.albums).toHaveLength(1));
    expect(result.current.albumNewName).toBe("");
    expect(result.current.albumCreateOpen).toBe(false);
  });

  it("drops a removed photo from the grid and decrements the count", async () => {
    const { result } = renderHook(() => useGalleryAlbums(status()));
    mockApi.mockResolvedValueOnce({ album: { id: "a1" }, assets: [asset("p1"), asset("p2")], total: 2 });
    await act(() => result.current.openAlbum("a1"));

    mockApi.mockResolvedValueOnce({});
    await act(() => result.current.removeFromAlbum("a1", "p1"));

    expect(result.current.albumAssets.map((a) => a.id)).toEqual(["p2"]);
    expect(result.current.albumTotal).toBe(1);
  });

  it("does nothing when asked to delete with no album open", async () => {
    const { result } = renderHook(() => useGalleryAlbums(status()));
    await act(() => result.current.confirmDeleteAlbum());
    expect(mockApi).not.toHaveBeenCalled();
  });
});
