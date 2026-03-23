import { EventEmitter } from "node:events";

import type { ProjectEvent } from "@vide/contracts";

export class ProjectEventBus {
  private readonly emitter = new EventEmitter();

  publish(event: ProjectEvent) {
    this.emitter.emit(event.projectId, event);
  }

  subscribe(projectId: string, listener: (event: ProjectEvent) => void) {
    this.emitter.on(projectId, listener);
    return () => this.emitter.off(projectId, listener);
  }
}
