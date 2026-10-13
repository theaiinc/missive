import { BadRequestException, Body, Controller, Get, Injectable, Put, Post, Query } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { PostgresService } from "./storage/postgres.service";

/**
 * Remote images in mail. They're hidden until the reader shows them (or
 * trusts the sender), and then load through the edge Worker's /img proxy
 * (packages/edge/src/image-proxy.ts), so the sender's server never sees the
 * reader's IP address or browser. This signs the proxy links: the Worker
 * only fetches what a signed-in reader asked for.
 */
export const MAX_URLS = 200;
/** Links last a day, rounded to the hour so the browser can cache them. */
const LINK_LIFETIME_S = 24 * 3600;

const addressHash = (address: string) => createHash("sha256").update(address.trim().toLowerCase()).digest("hex");

export function signImageUrl(url: string, secret: string, now = Date.now()): string {
  const e = Math.ceil(now / 1000 / 3600) * 3600 + LINK_LIFETIME_S;
  const s = createHmac("sha256", secret).update(`${url}|${e}`).digest("hex");
  return `/img?${new URLSearchParams({ u: url, e: String(e), s })}`;
}

@Injectable()
export class ImagesService {
  constructor(private readonly pg: PostgresService) {}

  sign(urls: string[]): Record<string, string> {
    const secret = process.env.EDGE_SECRET;
    if (!secret) return {};
    const out: Record<string, string> = {};
    for (const url of urls.slice(0, MAX_URLS)) {
      if (typeof url === "string" && /^https?:\/\//i.test(url) && url.length <= 4_096) out[url] = signImageUrl(url, secret);
    }
    return out;
  }

  async trusted(address: string): Promise<boolean> {
    const { rows } = await this.pg.query(`SELECT 1 FROM image_senders WHERE address_hash = $1`, [addressHash(address)]);
    return rows.length > 0;
  }

  async setTrusted(address: string, trusted: boolean): Promise<void> {
    if (trusted) {
      await this.pg.query(`INSERT INTO image_senders (address_hash) VALUES ($1) ON CONFLICT DO NOTHING`, [addressHash(address)]);
    } else {
      await this.pg.query(`DELETE FROM image_senders WHERE address_hash = $1`, [addressHash(address)]);
    }
  }
}

@Controller("api/v1/images")
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  /** Proxy links for a message's images, for the reader who's showing them. */
  @Post("sign")
  sign(@Body() body: { urls?: unknown }) {
    if (!Array.isArray(body?.urls)) throw new BadRequestException("Send the image URLs");
    return { urls: this.images.sign(body.urls as string[]) };
  }

  @Get("trusted")
  async trusted(@Query("address") address?: string) {
    if (!address?.includes("@")) throw new BadRequestException("Which address?");
    return { address, trusted: await this.images.trusted(address) };
  }

  @Put("trusted")
  async setTrusted(@Body() body: { address?: string; trusted?: boolean }) {
    if (!body?.address?.includes("@")) throw new BadRequestException("Which address?");
    await this.images.setTrusted(body.address, body.trusted !== false);
    return { address: body.address, trusted: body.trusted !== false };
  }
}
