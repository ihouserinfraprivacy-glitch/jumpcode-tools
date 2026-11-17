# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The Studio interface ships with the tool: plain CSS and JavaScript the host loads, and the mark and the cover as
data URLs in the manifest."""

import unittest

import support  # noqa: F401  (puts src on the path)
import jumpcode_sheetstudio as tool


class StudioUiTest(unittest.TestCase):
    def test_studio_ui_and_manifest(self):
        ui = tool.studio_ui()
        self.assertEqual([tool.MANIFEST["id"], tool.MANIFEST["studio"]["ui"], tool.MANIFEST["studio"]["mark"][:19],
                          tool.MANIFEST["studio"]["cover"][:15], bool(ui["css"]), "acquireVsCodeApi" in ui["js"]],
                         ["sheetstudio", True, "data:image/svg+xml;", "data:image/png;", True, True])


if __name__ == "__main__":
    unittest.main()
