#!/usr/bin/env python3
"""Simple local HTTP server for testing the PWA."""
import http.server
import socketserver
import os

PORT = 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

with socketserver.TCPServer(("", PORT), CORSHandler) as httpd:
    print(f"🌐 Serving at http://localhost:{PORT}")
    print(f"📂 Directory: {os.getcwd()}")
    print(f"🔗 Open: http://localhost:{PORT}/index.html")
    print(f"\nPress Ctrl+C to stop.")
    httpd.serve_forever()
