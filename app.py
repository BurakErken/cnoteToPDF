import json
import base64
import struct

def generate_html_viewer(cpage_file, output_html="Not_Okuyucu.html"):
    print("[*] İnteraktif HTML Okuyucu oluşturuluyor...")
    with open(cpage_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    strokes = data.get('_dkDrawing', [])
    all_points = []
    
    for stroke_b64 in strokes:
        try:
            binary_data = base64.b64decode(stroke_b64)
            i = 0
            while i < len(binary_data) - 9:
                if binary_data[i] == 0x0D and binary_data[i+5] == 0x15:
                    x = struct.unpack('<f', binary_data[i+1:i+5])[0]
                    y = struct.unpack('<f', binary_data[i+6:i+10])[0]
                    
                    # Ekran sınırları içindeki mantıklı verileri al
                    if -5000 < x < 5000 and -5000 < y < 5000:
                        # Veri boyutunu küçültmek için yuvarlama yapıyoruz
                        all_points.append((round(x, 2), round(y, 2)))
                    i += 10
                else:
                    i += 1
        except Exception:
            pass

    # Elde edilen verilerle bir Web Sayfası (HTML + JavaScript) oluştur
    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>CollaNote Okuyucu</title>
        <style>
            body {{ background-color: #2c3e50; text-align: center; font-family: Arial, sans-serif; }}
            canvas {{ background-color: white; box-shadow: 0px 0px 15px rgba(0,0,0,0.8); margin-top: 20px; cursor: crosshair; }}
            #controls {{ position: fixed; top: 20px; left: 20px; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); text-align: left; }}
        </style>
    </head>
    <body>
        <div id="controls">
            <h3 style="margin-top:0;">Not Okuyucu</h3>
            <label><strong>Kalem Kalınlığı:</strong> <span id="sizeVal">1.5</span></label><br>
            <input type="range" id="dotSize" min="0.1" max="6.0" step="0.1" value="1.5" style="width: 100%; margin-top:10px;"><br><br>
            <button onclick="draw()" style="width: 100%; padding: 10px; cursor:pointer;">Çizimi Güncelle</button>
            <hr>
            <p style="font-size: 13px; color: #555;">
                * <b>Ctrl + Fare Tekerleği</b> ile yakınlaşın.<br>
                * Okunabilirlik için soluk gelirse<br>kalınlığı artırın.<br>
                * Harfler birbirine girerse<br>kalınlığı düşürün.
            </p>
        </div>
        
        <canvas id="noteCanvas" width="2000" height="3000"></canvas>

        <script>
            // Python'dan gelen koordinat verileri
            const points = {json.dumps(all_points)};
            const canvas = document.getElementById('noteCanvas');
            const ctx = canvas.getContext('2d');
            
            function draw() {{
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                const size = document.getElementById('dotSize').value;
                document.getElementById('sizeVal').innerText = size;
                
                ctx.fillStyle = 'black';
                
                // Noktaları HTML5 Canvas üzerine çiz
                for(let i=0; i<points.length; i++) {{
                    let px = points[i][0];
                    let py = points[i][1];
                    
                    ctx.beginPath();
                    ctx.arc(px, py, size, 0, Math.PI * 2);
                    ctx.fill();
                }}
            }}
            
            // Sayfa açıldığında ilk çizimi yap
            draw();
            
            // Slider her oynatıldığında canlı olarak ekranı güncelle
            document.getElementById('dotSize').addEventListener('input', draw);
        </script>
    </body>
    </html>
    """
    
    with open(output_html, "w", encoding="utf-8") as f:
        f.write(html_content)
        
    print(f"[+] Başarılı! Toplam {len(all_points)} nokta çıkarıldı.")
    print(f"[+] '{output_html}' adlı dosya oluşturuldu.")
    print("[!] Lütfen oluşturulan bu Not_Okuyucu.html dosyasını Google Chrome'da açın.")

if __name__ == "__main__":
    cpage_dosyasi = r"C:\Users\Win11\Desktop\cnoteConverter\cnote_verileri\0.cpage" 
    generate_html_viewer(cpage_dosyasi)