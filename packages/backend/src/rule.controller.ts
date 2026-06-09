import { Controller, Get, Post, Body, Delete, Param } from "@nestjs/common";
import { RuleService } from "./rule.service";
import { StorageService } from "./storage/storage.service";
import type { CreateRuleRequest } from "@theaiinc/missive-core";

@Controller("api/v1/rules")
export class RuleController {
  constructor(
    private readonly rules: RuleService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list() {
    return this.rules.list();
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return this.rules.get(id);
  }

  @Post()
  async create(@Body() body: CreateRuleRequest) {
    if (!body.name || !body.conditions?.length || !body.actions?.length) {
      return { error: "name, conditions, and actions are required" };
    }
    return this.rules.create({
      name: body.name,
      description: body.description,
      conditions: body.conditions as any,
      actions: body.actions as any,
      enabled: body.enabled ?? true,
    });
  }

  @Post(":id/toggle")
  async toggle(@Param("id") id: string, @Body() body: { enabled: boolean }) {
    return this.rules.update(id, { enabled: body.enabled });
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    await this.rules.remove(id);
    return { deleted: true };
  }

  /** Evaluate all enabled rules against all existing missives */
  @Post("evaluate-all")
  async evaluateAll() {
    const results = await this.rules.evaluateAll();
    return { applied: results.applied, total: results.total };
  }
}
