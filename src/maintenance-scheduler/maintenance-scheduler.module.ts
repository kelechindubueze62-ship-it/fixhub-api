import { Injectable, Logger, Module } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Recurrence } from "@prisma/client";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { NotificationsModule, NotificationsService } from "../notifications/notifications.module";

// Phase 1 section 6.5 described this flow; nothing in Phase 6 ever read
// `next_due_date`. This is the fix: a daily job that finds every
// MaintenanceSchedule due within its own lead_time_days window, creates
// the corresponding Job, and rolls next_due_date forward — the thing
// that actually makes this a CMMS and not just a booking form.

function addRecurrence(date: Date, recurrence: Recurrence): Date {
  const d = new Date(date);
  switch (recurrence) {
    case "weekly":
      d.setDate(d.getDate() + 7);
      break;
    case "monthly":
      d.setMonth(d.getMonth() + 1);
      break;
    case "quarterly":
      d.setMonth(d.getMonth() + 3);
      break;
    case "biannual":
      d.setMonth(d.getMonth() + 6);
      break;
    case "annual":
      d.setFullYear(d.getFullYear() + 1);
      break;
  }
  return d;
}

@Injectable()
export class MaintenanceSchedulerService {
  private readonly logger = new Logger(MaintenanceSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService
  ) {}

  // Runs once a day. Exposed as a plain method (not just the @Cron
  // handler) specifically so it's callable directly from a test or a
  // manual admin "run now" trigger without waiting for the schedule.
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async generateDueJobs() {
    const dueSchedules = await this.prisma.maintenanceSchedule.findMany({
      where: { active: true },
      include: {
        asset: { include: { building: { include: { organization: { include: { memberships: true } } } } } },
        serviceSubcategory: true,
      },
    });

    const now = new Date();
    let created = 0;

    for (const schedule of dueSchedules) {
      const leadTimeCutoff = new Date(schedule.nextDueDate);
      leadTimeCutoff.setDate(leadTimeCutoff.getDate() - schedule.leadTimeDays);
      if (now < leadTimeCutoff) continue; // not within this schedule's own lead-time window yet

      const ownerMembership = schedule.asset.building.organization.memberships.find(
        (m) => m.role === "owner"
      );
      if (!ownerMembership) {
        this.logger.warn(
          `Skipping schedule ${schedule.id}: organization ${schedule.asset.building.organizationId} has no owner to attribute the job to`
        );
        continue;
      }

      const job = await this.prisma.job.create({
        data: {
          organizationId: schedule.asset.building.organizationId,
          buildingId: schedule.asset.buildingId,
          assetId: schedule.asset.id,
          serviceSubcategoryId: schedule.serviceSubcategoryId,
          createdByUserId: ownerMembership.userId,
          source: "preventive_schedule",
          priority: "normal",
          description: `Scheduled ${schedule.recurrence} maintenance: ${schedule.serviceSubcategory.name} on ${schedule.asset.name}`,
          requiresInspection: schedule.serviceSubcategory.requiresInspection,
        },
      });

      await this.prisma.jobStatusHistory.create({
        data: { jobId: job.id, status: "submitted", note: "Auto-generated from preventive maintenance schedule" },
      });

      await this.notifications.emit({
        userId: ownerMembership.userId,
        eventType: "maintenance_due",
        payload: { jobId: job.id, assetId: schedule.asset.id, assetName: schedule.asset.name },
      });

      await this.prisma.maintenanceSchedule.update({
        where: { id: schedule.id },
        data: { nextDueDate: addRecurrence(schedule.nextDueDate, schedule.recurrence) },
      });

      created += 1;
    }

    this.logger.log(`Preventive maintenance run: ${created} job(s) created from ${dueSchedules.length} active schedule(s)`);
    return { created, checked: dueSchedules.length };
  }
}

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [MaintenanceSchedulerService],
  exports: [MaintenanceSchedulerService],
})
export class MaintenanceSchedulerModule {}
