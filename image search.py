import json
import base64

def find_and_extract_images(json_data, image_count=0):
    # Veri bir sözlükse (dict), içindeki tüm elemanları tara
    if isinstance(json_data, dict):
        for key, value in json_data.items():
            # _dkDrawing içindeki çizimleri atla ki hızlanalım
            if key == '_dkDrawing':
                continue
            image_count = find_and_extract_images(value, image_count)
            
    # Veri bir listeyse, içindeki her bir öğeyi tara
    elif isinstance(json_data, list):
        for item in json_data:
            image_count = find_and_extract_images(item, image_count)
            
    # Veri bir metinse (string), bunun bir resim olup olmadığını kontrol et
    elif isinstance(json_data, str):
        # JPEG veya PNG imzası kontrolü
        if json_data.startswith('/9j/') or json_data.startswith('iVBORw'):
            try:
                # Uzantıyı belirle
                ext = ".jpg" if json_data.startswith('/9j/') else ".png"
                
                # Şifreyi çöz ve resmi kaydet
                img_data = base64.b64decode(json_data)
                filename = f"sayfa_icinden_cikan_resim_{image_count}{ext}"
                
                with open(filename, "wb") as f:
                    f.write(img_data)
                print(f"[+] Hedef Vuruldu! Resim başarıyla çıkarıldı: {filename}")
                image_count += 1
            except Exception as e:
                print(f"[-] Çıkarma hatası: {e}")
                
    return image_count

def extract_images_from_cpage(cpage_file):
    print(f"[*] '{cpage_file}' dosyasının dehlizlerinde gizli resimler aranıyor...")
    
    with open(cpage_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    total_images = find_and_extract_images(data)
    
    if total_images == 0:
        print("[-] Sayfa dosyasında gömülü resim bulunamadı.")

if __name__ == "__main__":
    cpage_dosyasi = r"C:\Users\Win11\Desktop\cnoteConverter\cnote_verileri\0.cpage" 
    extract_images_from_cpage(cpage_dosyasi)