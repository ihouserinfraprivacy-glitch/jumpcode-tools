class Entrega {
  Entrega({required this.id, required this.endereco, required this.latitude, required this.longitude});
  final String id;
  final String endereco;
  final double latitude;
  final double longitude;

  factory Entrega.deJson(Map<String, dynamic> json) =>
      Entrega(id: json['id'], endereco: json['endereco'], latitude: json['lat'], longitude: json['lng']);
}
