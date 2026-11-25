import { describe, it, expect, vi } from "vitest";
import { createWorkerAuditSink, AuditEvent } from "../../src/bot/worker-audit";

function makeEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    slack_user_id: "U123",
    brand_id: "tnl",
    asset_id: "a1",
    output_format: "png",
    width: 1200,
    height: 630,
    background: "white",
    padding_ratio: null,
    purpose: "官網首頁",
    purpose_url: null,
    assetLabel: "logo-blue.png",
    ...over,
  };
}

function fakeRepo() {
  return {
    getBrandById: vi.fn(async () => ({ id: "tnl", display_name: "TNL Mediagene" } as any)),
    getAllBrands: vi.fn(async () => []),
    getActiveAssets: vi.fn(async () => []),
    findAssets: vi.fn(async () => []),
    recordDelivery: vi.fn(async () => {}),
  };
}

function fakeClient() {
  const posts: any[] = [];
  return {
    posts,
    chat: { postMessage: vi.fn(async (a: any) => { posts.push(a); }) },
  };
}

describe("createWorkerAuditSink", () => {
  it("writes the D1 row and posts a notice to each configured channel", async () => {
    const repo = fakeRepo();
    const client = fakeClient();
    const sink = createWorkerAuditSink(repo as any, client as any, ["C_REVIEW", "C_OPS"]);

    await sink(makeEvent());

    // Row written WITHOUT the assetLabel (that's notice-only).
    expect(repo.recordDelivery).toHaveBeenCalledTimes(1);
    const row = repo.recordDelivery.mock.calls[0][0];
    expect(row).not.toHaveProperty("assetLabel");
    expect(row.slack_user_id).toBe("U123");
    expect(row.width).toBe(1200);

    // One notice per channel, resolving the brand display name.
    expect(client.posts).toHaveLength(2);
    expect(client.posts[0].channel).toBe("C_REVIEW");
    expect(client.posts[0].text).toContain("TNL Mediagene");
    expect(client.posts[0].text).toContain("<@U123>");
    expect(client.posts[0].text).toContain("logo-blue.png");
    expect(client.posts[0].text).toContain("1200×630");
  });

  it("records the row but posts nothing when no channels are configured", async () => {
    const repo = fakeRepo();
    const client = fakeClient();
    const sink = createWorkerAuditSink(repo as any, client as any, []);

    await sink(makeEvent());

    expect(repo.recordDelivery).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("swallows a D1 write failure (delivery already happened)", async () => {
    const repo = fakeRepo();
    repo.recordDelivery = vi.fn(async () => { throw new Error("D1 down"); });
    const client = fakeClient();
    const sink = createWorkerAuditSink(repo as any, client as any, ["C_REVIEW"]);

    // Must not throw; still attempts the notice.
    await expect(sink(makeEvent())).resolves.toBeUndefined();
    expect(client.posts).toHaveLength(1);
  });

  it("swallows a notice failure without throwing", async () => {
    const repo = fakeRepo();
    const client = fakeClient();
    client.chat.postMessage = vi.fn(async () => { throw new Error("channel gone"); });
    const sink = createWorkerAuditSink(repo as any, client as any, ["C_REVIEW"]);

    await expect(sink(makeEvent())).resolves.toBeUndefined();
    expect(repo.recordDelivery).toHaveBeenCalledTimes(1);
  });

  it("shows 原始尺寸 when no width/height and includes the purpose URL when present", async () => {
    const repo = fakeRepo();
    const client = fakeClient();
    const sink = createWorkerAuditSink(repo as any, client as any, ["C_REVIEW"]);

    await sink(makeEvent({ width: null, height: null, output_format: "svg", purpose_url: "https://x.test" }));

    expect(client.posts[0].text).toContain("原始尺寸");
    expect(client.posts[0].text).toContain("https://x.test");
  });
});
