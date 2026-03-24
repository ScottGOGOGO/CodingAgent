import { EventEmitter } from "node:events";

import type { ProjectEvent } from "@vide/contracts";

export class ProjectEventBus {
  private readonly emitter = new EventEmitter();

  publish(event: ProjectEvent) {
    this.emitter.emit(event.projectId, event);
  }

  subscribe(projectId: string, listener: (event: ProjectEvent) => void) {
    const safeListener = (event: ProjectEvent) => {
      try {
        listener(event);
      } catch (error) {
        console.error(`Event subscriber error for project ${projectId}:`, error);
      }
    };
    this.emitter.on(projectId, safeListener);
    return () => this.emitter.off(projectId, safeListener);
  }
}
