# Task B edit spec (copy)

Live copy used in the demo sits at the root of the fixture repo (flask-fixture/TASK_B_EDITS.md).
The agent was instructed to stage exactly these edits. Copied here so the source snapshot is self-contained.


Stage each edit below with one stage_edit call. For every edit: `path` is the file path, `old_string` is EXACTLY the content of the OLD block, and `new_string` is EXACTLY the content of the NEW block. Copy indentation and blank lines exactly. Apply them in the listed order. Do not change anything else.

## Edit 1 - `src/flask/cli.py`

OLD:
```
from werkzeug.utils import import_string
```

NEW:
```
from werkzeug.utils import import_string
import json
```

## Edit 2 - `src/flask/cli.py`

OLD:
```
            self.add_command(routes_command)
```

NEW:
```
            self.add_command(routes_command)
            self.add_command(config_command)
```

## Edit 3 - `src/flask/cli.py`

OLD:
```
cli = FlaskGroup(
```

NEW:
```
def _mask_config(key, value):
    upper = key.upper()
    if any(sub in upper for sub in ("SECRET", "PASSWORD", "TOKEN", "KEY")):
        return "***"
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


cli = FlaskGroup(
```

## Edit 4 - `src/flask/cli.py`

OLD:
```
cli = FlaskGroup(
```

NEW:
```
@click.command("config", short_help="Show the configuration of the app.")
@with_appcontext
def config_command():
    masked = {k: _mask_config(k, v) for k, v in current_app.config.items()}
    click.echo(json.dumps(masked, indent=2, sort_keys=True, default=str))


cli = FlaskGroup(
```

## Edit 5 - `tests/test_cli.py`

OLD:
```
import importlib.metadata
```

NEW:
```
import importlib.metadata
import json
```

## Edit 6 - `tests/test_cli.py`

OLD:
```
    def test_subdomain(self, runner):
```

NEW:
```
    def test_config_command(self, runner):
        app = Flask(__name__)
        app.config["SECRET_KEY"] = "supersecretvalue"

    def test_subdomain(self, runner):
```

## Edit 7 - `tests/test_cli.py`

OLD:
```
    def test_subdomain(self, runner):
```

NEW:
```
        cli = FlaskGroup(create_app=lambda: app)
        result = runner.invoke(cli, ["config"])
        assert result.exit_code == 0
        assert json.loads(result.output)["SECRET_KEY"] == "***"

    def test_subdomain(self, runner):
```

## Edit 8 - `docs/cli.rst`

OLD:
```
Custom Commands
---------------
```

NEW:
```
Showing the Configuration
-------------------------

The ``flask config`` command prints the application's configuration as
sorted JSON. Secret-looking values are masked as ``***``.

Custom Commands
---------------
```

## Edit 9 - `docs/cli.rst`

OLD:
```
Custom Commands
---------------
```

NEW:
```
.. code-block:: text

    $ flask config
    {
      "SECRET_KEY": "***",
      ...
    }


Custom Commands
---------------
```
