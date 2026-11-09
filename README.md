# Nowa Online World — Yayıncı Rehberi

Nowa Online World topluluğunun yayıncılarını listeleyen, mobil uyumlu ve Supabase bağlantılı web uygulaması.

## Özellikler
- Yayıncı adıyla arama
- Platform filtresi: TikTok, YouTube, Twitch, Kick, Instagram ve Facebook
- Canlı / çevrimdışı durumu filtresi
- Yayıncı profil görseli, açıklama ve kanal bağlantısı
- Yönetici girişi
- Yönetici panelinden yayıncı ekleme, düzenleme, silme, sıralama ve yayında/gizli durumu
- Supabase veritabanı ve Row Level Security ile korunan yönetici işlemleri

## Yönetici erişimini etkinleştirme
1. Supabase Auth bölümünde yönetici olarak kullanacağınız e-posta ile bir kullanıcı oluşturun.
2. Bu kullanıcı giriş yapabildikten sonra Supabase SQL Editor'de aşağıdaki sorguyu, kendi e-posta adresinizle çalıştırın:

```sql
insert into public.nowa_admins (user_id)
select id from auth.users where email = 'YONETICI_EPOSTA_ADRESI'
on conflict (user_id) do nothing;
```

3. Site üzerindeki **Yönetici Paneli** düğmesinden aynı e-posta ve şifreyle giriş yapın.

Yeni kullanıcı kaydı site üzerinden açık değildir. Yönetici yetkisi yalnızca `nowa_admins` tablosuna eklenen hesaplara verilir.

## Veri güvenliği
- Ziyaretçiler yalnızca yayınlanmış yayıncıları görebilir.
- Yayıncı ekleme, düzenleme ve silme işlemleri yönetici yetkisi ve RLS politikalarıyla sınırlandırılmıştır.
- Tarayıcıda yalnızca Supabase publishable key bulunur; service-role/secret key kullanılmaz.

## Proje
- GitHub: https://github.com/quetraonline/nowaonline
- Vercel: https://vercel.com/quetraonline/nowaonline
- Site: https://nowaonline.vercel.app
