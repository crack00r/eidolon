"""Structured JSON logging configuration for the Eidolon GPU Worker."""

import json
import logging
import sys
from datetime import datetime, timezone


class JsonFormatter(logging.Formatter):
    """Formats log records as single-line JSON objects.

    Output format:
        {"timestamp": "...", "level": "...", "module": "...", "message": "...", "data": {...}}
    """

    def format(self, record: logging.LogRecord) -> str:
        entry: dict = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "module": record.name,
            "message": record.getMessage(),
        }

        # Attach request_id if present on the record
        request_id = getattr(record, "request_id", None)
        if request_id:
            entry["request_id"] = request_id

        # Attach extra structured data if present
        data = getattr(record, "data", None)
        if data:
            entry["data"] = data

        # Include exception info when available
        if record.exc_info and record.exc_info[1] is not None:
            entry["exception"] = self.formatException(record.exc_info)

        return json.dumps(entry, default=str)


def configure_logging(level: str = "INFO") -> None:
    """Configure the root logger with JSON output to stderr.

    Args:
        level: Log level name (DEBUG, INFO, WARNING, ERROR, CRITICAL).
    """
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())

    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    root_logger.handlers.clear()
    root_logger.addHandler(handler)

    # Reduce noise from third-party libraries
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(logging.INFO)
