from __future__ import annotations

import queue
import threading
from typing import Callable, TypeVar

from app.config import get_settings


ResultT = TypeVar("ResultT")


class ModelInvokeTimeoutError(TimeoutError):
    pass


def invoke_with_hard_timeout(
    func: Callable[[], ResultT],
    timeout_seconds: float | None,
    timeout_message: str,
) -> ResultT:
    settings = get_settings()
    if settings.model_timeout_seconds <= 0 or timeout_seconds is None or timeout_seconds <= 0:
        return func()

    result_queue: queue.Queue[tuple[str, object]] = queue.Queue(maxsize=1)

    def runner() -> None:
        try:
            result_queue.put(("ok", func()))
        except BaseException as exc:  # noqa: BLE001
            result_queue.put(("error", exc))

    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    thread.join(timeout_seconds)

    if thread.is_alive():
        raise ModelInvokeTimeoutError(timeout_message)

    status, payload = result_queue.get()
    if status == "error":
        raise payload  # type: ignore[misc]
    return payload  # type: ignore[return-value]
