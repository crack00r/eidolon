"""Tests for JSON logging configuration."""

import json
import logging

import pytest

from src.logging_config import JsonFormatter, configure_logging


class TestJsonFormatter:
    """JsonFormatter produces valid JSON log entries."""

    def test_basic_format(self):
        formatter = JsonFormatter()
        record = logging.LogRecord(
            name="test.module",
            level=logging.INFO,
            pathname="test.py",
            lineno=1,
            msg="Hello %s",
            args=("world",),
            exc_info=None,
        )
        output = formatter.format(record)
        data = json.loads(output)

        assert data["level"] == "INFO"
        assert data["module"] == "test.module"
        assert data["message"] == "Hello world"
        assert "timestamp" in data

    def test_includes_request_id(self):
        formatter = JsonFormatter()
        record = logging.LogRecord(
            name="test", level=logging.INFO, pathname="", lineno=1,
            msg="test", args=(), exc_info=None,
        )
        record.request_id = "req-123"  # type: ignore[attr-defined]
        data = json.loads(formatter.format(record))
        assert data["request_id"] == "req-123"

    def test_includes_extra_data(self):
        formatter = JsonFormatter()
        record = logging.LogRecord(
            name="test", level=logging.INFO, pathname="", lineno=1,
            msg="test", args=(), exc_info=None,
        )
        record.data = {"key": "value"}  # type: ignore[attr-defined]
        data = json.loads(formatter.format(record))
        assert data["data"] == {"key": "value"}

    def test_omits_request_id_when_absent(self):
        formatter = JsonFormatter()
        record = logging.LogRecord(
            name="test", level=logging.INFO, pathname="", lineno=1,
            msg="test", args=(), exc_info=None,
        )
        data = json.loads(formatter.format(record))
        assert "request_id" not in data

    def test_includes_exception_info(self):
        formatter = JsonFormatter()
        try:
            raise ValueError("test error")
        except ValueError:
            import sys
            exc_info = sys.exc_info()

        record = logging.LogRecord(
            name="test", level=logging.ERROR, pathname="", lineno=1,
            msg="error occurred", args=(), exc_info=exc_info,
        )
        data = json.loads(formatter.format(record))
        assert "exception" in data
        assert "ValueError" in data["exception"]

    def test_output_is_single_line(self):
        formatter = JsonFormatter()
        record = logging.LogRecord(
            name="test", level=logging.INFO, pathname="", lineno=1,
            msg="multi\nline\nmessage", args=(), exc_info=None,
        )
        output = formatter.format(record)
        # JSON dumps shouldn't produce multiple lines (no indent)
        assert "\n" not in output or output.count("\n") == 0

    def test_timestamp_is_iso_format(self):
        formatter = JsonFormatter()
        record = logging.LogRecord(
            name="test", level=logging.INFO, pathname="", lineno=1,
            msg="test", args=(), exc_info=None,
        )
        data = json.loads(formatter.format(record))
        # ISO format should contain T separator and timezone info
        assert "T" in data["timestamp"]


class TestConfigureLogging:
    """configure_logging sets up root logger correctly."""

    def test_sets_log_level(self):
        configure_logging(level="DEBUG")
        root = logging.getLogger()
        assert root.level == logging.DEBUG

    def test_sets_info_level_by_default(self):
        configure_logging()
        root = logging.getLogger()
        assert root.level == logging.INFO

    def test_case_insensitive_level(self):
        configure_logging(level="warning")
        root = logging.getLogger()
        assert root.level == logging.WARNING

    def test_invalid_level_falls_back_to_info(self):
        configure_logging(level="INVALID")
        root = logging.getLogger()
        assert root.level == logging.INFO

    def test_handler_uses_json_formatter(self):
        configure_logging()
        root = logging.getLogger()
        assert len(root.handlers) >= 1
        assert isinstance(root.handlers[0].formatter, JsonFormatter)
