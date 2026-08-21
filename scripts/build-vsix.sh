#!/bin/bash
set -e

cd /Volumes/Work/CY/structured/cy-new

# Read version from package.json
VERSION=$(node -p "require('./package.json').version")
echo "Building CY v$VERSION..."

# Create a temporary directory for the package
TEMP_DIR=$(mktemp -d)
echo "Created temp directory: $TEMP_DIR"

# Create extension subdirectory (VS Code expects extension/ folder)
EXT_DIR="$TEMP_DIR/extension"
mkdir -p "$EXT_DIR"
echo "Created extension directory: $EXT_DIR"

# Copy all files to extension subdirectory
cp -r webview "$EXT_DIR/"
cp -r resources "$EXT_DIR/"
cp -r syntaxes "$EXT_DIR/"
cp -r media "$EXT_DIR/"
cp -r bin "$EXT_DIR/"
cp -r api-worker "$EXT_DIR/"
cp -r platform-worker "$EXT_DIR/"
cp -r scripts "$EXT_DIR/"
cp -r out "$EXT_DIR/"
cp package.json "$EXT_DIR/"
cp .vscodeignore "$EXT_DIR/"
cp LICENSE.md "$EXT_DIR/"
cp readme.md "$EXT_DIR/"
cp platform-server.js "$EXT_DIR/"

# Add extension files
cp cy-new/node_modules/@vscode/webview-ui-toolkit/dist/webview-ui-toolkit.js "$EXT_DIR/out/" 2>/dev/null || true

# Create the VSIX package
cd "$TEMP_DIR"
zip -r "/Volumes/Work/CY/structured/cy-new/cy-$VERSION.vsix" . -x "*.DS_Store" -x "*/.vscode/*" -x "*/node_modules/*" -x "*/.git/*"

# Clean up
rm -rf "$TEMP_DIR"

echo "Built: cy-$VERSION.vsix"
