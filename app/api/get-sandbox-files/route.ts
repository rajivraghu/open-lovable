import { NextResponse } from 'next/server';
import { parseJavaScriptFile, buildComponentTree } from '@/lib/file-parser';
import { FileManifest, FileInfo, RouteInfo } from '@/types/file-manifest';
import type { SandboxState } from '@/types/sandbox';

declare global {
  var activeSandbox: any;
}

export async function GET() {
  try {
    if (!global.activeSandbox) {
      return NextResponse.json({
        success: false,
        error: 'No active sandbox'
      }, { status: 404 });
    }

    console.log('[get-sandbox-files] Fetching and analyzing file structure...');
    
    // Get all React/JS/CSS files
    const result = await global.activeSandbox.runCode(`
import os
import json

# Change to the app directory
os.chdir('/home/user/app')

# Get files with content
files_content = {}

# Define the files we want to read
target_files = [
    'package.json',
    'vite.config.js',
    'tailwind.config.js',
    'postcss.config.js',
    'index.html',
    'src/main.jsx',
    'src/App.jsx',
    'src/index.css'
]

# Read each target file
for file_path in target_files:
    if os.path.exists(file_path):
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                files_content[file_path] = content
                print(f"Read {file_path}: {len(content)} chars")
        except Exception as e:
            print(f"Error reading {file_path}: {e}")

# Also scan for any additional JS/JSX/CSS files
for root, dirs, files in os.walk('.'):
    # Skip node_modules and other unwanted directories
    dirs[:] = [d for d in dirs if d not in ['node_modules', '.git', 'dist', 'build']]

    for file in files:
        if file.endswith(('.jsx', '.js', '.tsx', '.ts', '.css', '.json', '.html')):
            file_path = os.path.join(root, file)
            relative_path = os.path.relpath(file_path, '.')

            # Skip if we already have this file
            if relative_path in files_content:
                continue

            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    # Only include files under 10KB to avoid huge responses
                    if len(content) < 10000:
                        files_content[relative_path] = content
                        print(f"Found additional file {relative_path}: {len(content)} chars")
            except Exception as e:
                print(f"Error reading {file_path}: {e}")

# Get directory structure
structure = []
for root, dirs, files in os.walk('.'):
    # Skip node_modules for structure display
    if 'node_modules' in root:
        continue

    level = root.replace('.', '').count(os.sep)
    indent = ' ' * 2 * level
    basename = os.path.basename(root) if root != '.' else 'app'
    structure.append(f"{indent}{basename}/")

    sub_indent = ' ' * 2 * (level + 1)
    for file in files:
        structure.append(f"{sub_indent}{file}")

result = {
    'files': files_content,
    'structure': '\\n'.join(structure[:50])  # Limit structure to 50 lines
}

print("=== FINAL RESULT ===")
print(json.dumps(result))
    `);

    const output = result.logs.stdout.join('');
    console.log('[get-sandbox-files] Raw output:', output);

    // Find the JSON output after "=== FINAL RESULT ==="
    const finalResultIndex = output.indexOf('=== FINAL RESULT ===');
    if (finalResultIndex === -1) {
      console.error('[get-sandbox-files] No final result marker found in:', output);
      throw new Error('No final result marker found in sandbox output');
    }

    const jsonPart = output.substring(finalResultIndex + '=== FINAL RESULT ==='.length).trim();
    const lines = jsonPart.split('\n');
    let jsonLine = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{')) {
        jsonLine = trimmed;
        break;
      }
    }

    if (!jsonLine) {
      console.error('[get-sandbox-files] No JSON output found after final result marker');
      throw new Error('No valid JSON output from sandbox');
    }

    console.log('[get-sandbox-files] Parsing JSON:', jsonLine.substring(0, 200) + '...');
    const parsedResult = JSON.parse(jsonLine);
    
    // Build enhanced file manifest
    const fileManifest: FileManifest = {
      files: {},
      routes: [],
      componentTree: {},
      entryPoint: '',
      styleFiles: [],
      timestamp: Date.now(),
    };
    
    // Process each file
    for (const [relativePath, content] of Object.entries(parsedResult.files)) {
      const fullPath = `/home/user/app/${relativePath}`;
      
      // Create base file info
      const fileInfo: FileInfo = {
        content: content as string,
        type: 'utility',
        path: fullPath,
        relativePath,
        lastModified: Date.now(),
      };
      
      // Parse JavaScript/JSX files
      if (relativePath.match(/\.(jsx?|tsx?)$/)) {
        const parseResult = parseJavaScriptFile(content as string, fullPath);
        Object.assign(fileInfo, parseResult);
        
        // Identify entry point
        if (relativePath === 'src/main.jsx' || relativePath === 'src/index.jsx') {
          fileManifest.entryPoint = fullPath;
        }
        
        // Identify App.jsx
        if (relativePath === 'src/App.jsx' || relativePath === 'App.jsx') {
          fileManifest.entryPoint = fileManifest.entryPoint || fullPath;
        }
      }
      
      // Track style files
      if (relativePath.endsWith('.css')) {
        fileManifest.styleFiles.push(fullPath);
        fileInfo.type = 'style';
      }
      
      fileManifest.files[fullPath] = fileInfo;
    }
    
    // Build component tree
    fileManifest.componentTree = buildComponentTree(fileManifest.files);
    
    // Extract routes (simplified - looks for Route components or page pattern)
    fileManifest.routes = extractRoutes(fileManifest.files);
    
    // Update global file cache with manifest
    if (global.sandboxState?.fileCache) {
      global.sandboxState.fileCache.manifest = fileManifest;
    }

    return NextResponse.json({
      success: true,
      files: parsedResult.files,
      structure: parsedResult.structure,
      fileCount: Object.keys(parsedResult.files).length,
      manifest: fileManifest,
    });

  } catch (error) {
    console.error('[get-sandbox-files] Error:', error);
    return NextResponse.json({
      success: false,
      error: (error as Error).message
    }, { status: 500 });
  }
}

function extractRoutes(files: Record<string, FileInfo>): RouteInfo[] {
  const routes: RouteInfo[] = [];
  
  // Look for React Router usage
  for (const [path, fileInfo] of Object.entries(files)) {
    if (fileInfo.content.includes('<Route') || fileInfo.content.includes('createBrowserRouter')) {
      // Extract route definitions (simplified)
      const routeMatches = fileInfo.content.matchAll(/path=["']([^"']+)["'].*(?:element|component)={([^}]+)}/g);
      
      for (const match of routeMatches) {
        const [, routePath, componentRef] = match;
        routes.push({
          path: routePath,
          component: path,
        });
      }
    }
    
    // Check for Next.js style pages
    if (fileInfo.relativePath.startsWith('pages/') || fileInfo.relativePath.startsWith('src/pages/')) {
      const routePath = '/' + fileInfo.relativePath
        .replace(/^(src\/)?pages\//, '')
        .replace(/\.(jsx?|tsx?)$/, '')
        .replace(/index$/, '');
        
      routes.push({
        path: routePath,
        component: path,
      });
    }
  }
  
  return routes;
}