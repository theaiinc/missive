import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CalendarService, type EventInput } from "./calendar.service";

/** The calendar (pages/Calendar in the web app). Everything is the signed-in person's own (row-level security). */
@Controller("api/v1/calendar")
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get("calendars")
  list() {
    return this.calendar.list();
  }

  @Post("calendars")
  create(@Body() body: { name?: string; color?: string }) {
    return this.calendar.create({ name: body.name ?? "", color: body.color });
  }

  @Patch("calendars/:id")
  update(@Param("id") id: string, @Body() body: { name?: string; color?: string; visible?: boolean }) {
    return this.calendar.update(id, body);
  }

  @Delete("calendars/:id")
  async remove(@Param("id") id: string) {
    await this.calendar.remove(id);
    return { deleted: true };
  }

  @Post("calendars/:id/refresh")
  refresh(@Param("id") id: string) {
    return this.calendar.refresh(id);
  }

  @Get("calendars/:id/export")
  async export(@Param("id") id: string, @Res() res: Response) {
    const { name, ics } = await this.calendar.exportIcs(id);
    const file = `${name.replace(/[^\w .-]+/g, "").trim() || "calendar"}.ics`;
    res.setHeader("content-type", "text/calendar; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${file}"`);
    res.send(ics);
  }

  /** An .ics file as the request body (text/calendar), into ?calendarId or a new calendar (?name). */
  @Post("import")
  importIcs(@Body() body: unknown, @Query("calendarId") calendarId?: string, @Query("name") name?: string) {
    if (typeof body !== "string") throw new BadRequestException("Send the .ics file as text/calendar");
    return this.calendar.importIcs(body, { calendarId, name });
  }

  @Post("subscribe")
  subscribe(@Body() body: { url?: string; name?: string; color?: string }) {
    if (!body.url) throw new BadRequestException("A calendar link is needed");
    return this.calendar.subscribe({ url: body.url, name: body.name, color: body.color });
  }

  @Get("accounts")
  accounts() {
    return this.calendar.accounts();
  }

  @Post("accounts/:connectorId/sync")
  syncAccount(@Param("connectorId") connectorId: string) {
    return this.calendar.syncAccount(connectorId);
  }

  @Get("events")
  events(@Query("from") from: string, @Query("to") to: string) {
    return this.calendar.events(from, to);
  }

  @Post("events")
  createEvent(@Body() body: EventInput) {
    return this.calendar.createEvent(body);
  }

  @Put("events/:id")
  updateEvent(@Param("id") id: string, @Body() body: EventInput) {
    return this.calendar.updateEvent(id, body);
  }

  @Delete("events/:id")
  async deleteEvent(@Param("id") id: string, @Query("occurrence") occurrence?: string) {
    await this.calendar.deleteEvent(id, occurrence);
    return { deleted: true };
  }
}
